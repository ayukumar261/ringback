package elevenlabs

import (
	"context"
	"net"
	"sync"

	"github.com/coder/websocket"

	"github.com/ayukumar261/ringback/apps/worker/internal/agent"
)

// Conversation is one live agent call over a websocket.
type Conversation struct {
	conn     *websocket.Conn
	meta     InitMetadata
	events   chan agent.Event
	ctx      context.Context
	cancel   context.CancelFunc
	pumpDone chan struct{}

	mu    sync.Mutex
	ended bool
	err   error
}

// newConversation wires up a conversation and starts its read pump.
func newConversation(parent context.Context, conn *websocket.Conn, meta InitMetadata) *Conversation {
	ctx, cancel := context.WithCancel(parent)
	c := &Conversation{
		conn:     conn,
		meta:     meta,
		events:   make(chan agent.Event, eventsBuffer),
		ctx:      ctx,
		cancel:   cancel,
		pumpDone: make(chan struct{}),
	}
	go c.pump()
	return c
}

// SendAudio sends one chunk of caller PCM to the agent.
func (c *Conversation) SendAudio(pcm []byte) error {
	if c.ctx.Err() != nil {
		return net.ErrClosed
	}
	frame, err := EncodeAudioChunk(pcm)
	if err != nil {
		return err
	}
	return c.conn.Write(c.ctx, websocket.MessageText, frame)
}

// SendTool answers one tool call from the agent.
func (c *Conversation) SendTool(id, result string, isErr bool) error {
	if c.ctx.Err() != nil {
		return net.ErrClosed
	}
	frame, err := EncodeToolResult(id, result, isErr)
	if err != nil {
		return err
	}
	return c.conn.Write(c.ctx, websocket.MessageText, frame)
}

// Events returns agent events in arrival order until the conversation ends.
func (c *Conversation) Events() <-chan agent.Event { return c.events }

// ID reports the conversation id ElevenLabs assigned at handshake.
func (c *Conversation) ID() string { return c.meta.ConversationID }

// Meta reports the metadata announced by the server at handshake.
func (c *Conversation) Meta() InitMetadata { return c.meta }

// Err reports why the conversation ended.
func (c *Conversation) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

// Close ends the conversation and waits for the event stream to close.
func (c *Conversation) Close() error {
	c.terminate(nil)
	<-c.pumpDone
	return nil
}

// pump reads server frames and forwards events until the conversation ends.
func (c *Conversation) pump() {
	defer close(c.pumpDone)
	defer close(c.events)
	for {
		_, data, err := c.conn.Read(c.ctx)
		if err != nil {
			if c.ctx.Err() != nil {
				err = c.ctx.Err()
			}
			c.terminate(err)
			return
		}
		env, err := decodeFrame(data)
		if err != nil {
			c.terminate(err)
			return
		}
		if env.Type == "ping" {
			if env.Ping == nil {
				c.terminate(errMissingPayload(env.Type, "ping_event"))
				return
			}
			frame, err := EncodePong(env.Ping.EventID)
			if err == nil {
				err = c.conn.Write(c.ctx, websocket.MessageText, frame)
			}
			if err != nil {
				c.terminate(err)
				return
			}
			continue
		}
		ev, err := env.event(data)
		if err != nil {
			c.terminate(err)
			return
		}
		select {
		case c.events <- ev:
		case <-c.ctx.Done():
			c.terminate(c.ctx.Err())
			return
		}
	}
}

// terminate shuts the conversation down and keeps the first ending error.
func (c *Conversation) terminate(err error) {
	c.mu.Lock()
	if !c.ended {
		c.ended = true
		c.err = err
	}
	c.mu.Unlock()
	c.cancel()
	c.conn.CloseNow()
}
