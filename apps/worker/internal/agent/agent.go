// Package agent is the bridge's provider-neutral view of one voice agent conversation.
package agent

import (
	"context"
	"encoding/json"
)

// Event is one thing the agent told us during a conversation.
type Event interface{ isEvent() }

// Audio is agent speech as raw PCM.
type Audio struct {
	PCM     []byte
	EventID int
}

func (Audio) isEvent() {}

// Interruption means the person on the call started talking over the agent.
type Interruption struct {
	EventID int
	Reason  string
}

func (Interruption) isEvent() {}

// UserTurn is what the person on the call just said.
type UserTurn struct {
	Text    string
	EventID int
}

func (UserTurn) isEvent() {}

// AgentTurn is the text the agent is about to speak.
type AgentTurn struct {
	Text    string
	EventID int
}

func (AgentTurn) isEvent() {}

// Correction is what the agent managed to say before being cut off.
type Correction struct {
	Original  string
	Corrected string
	EventID   int
}

func (Correction) isEvent() {}

// Error is a fatal error reported by the agent provider.
type Error struct {
	Code    int
	Name    string
	Message string
}

func (Error) isEvent() {}

// Unknown is any provider frame the adapter does not model.
type Unknown struct {
	Type string
	Raw  []byte
}

func (Unknown) isEvent() {}

// Tool is a request from the agent for the worker to run a tool and reply with SendTool.
type Tool struct {
	ID     string
	Name   string
	Params json.RawMessage
}

func (Tool) isEvent() {}

// Start is what the bridge hands a provider once the call is answered.
type Start struct {
	Prompt string // the call's prompt, empty means the provider's own default prompt runs
}

// Provider opens conversations with one voice agent.
type Provider interface {
	Start(ctx context.Context, s Start) (Conversation, error)
}

// Conversation is one live agent call as the bridge sees it.
type Conversation interface {
	ID() string // the provider's identifier for this conversation
	SendAudio(pcm []byte) error
	SendTool(id, result string, isErr bool) error
	Events() <-chan Event
	Err() error
	Close() error
}
