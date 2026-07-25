package elevenlabs

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/coder/websocket"
)

const (
	defaultBaseURL     = "https://api.elevenlabs.io"
	defaultAudioFormat = "pcm_48000"
	handshakeTimeout   = 10 * time.Second
	maxFrameBytes      = 1 << 20
	eventsBuffer       = 16
)

// Client creates conversations with one ElevenLabs agent.
type Client struct {
	APIKey     string
	AgentID    string
	BaseURL    string
	HTTPClient *http.Client
}

// StartOpts configures one conversation.
type StartOpts struct {
	Init         InitData
	InputFormat  string // empty means pcm_48000
	OutputFormat string // empty means pcm_48000
}

// Start opens one conversation and returns once the handshake completes.
func (c *Client) Start(ctx context.Context, opts StartOpts) (*Conversation, error) {
	if c.APIKey == "" || c.AgentID == "" {
		return nil, fmt.Errorf("elevenlabs: client needs APIKey and AgentID")
	}
	in, out := opts.InputFormat, opts.OutputFormat
	if in == "" {
		in = defaultAudioFormat
	}
	if out == "" {
		out = defaultAudioFormat
	}

	hsCtx, hsCancel := context.WithTimeout(ctx, handshakeTimeout)
	defer hsCancel()

	wsURL, err := c.signedURL(hsCtx)
	if err != nil {
		return nil, err
	}
	conn, _, err := websocket.Dial(hsCtx, wsURL, nil)
	if err != nil {
		return nil, fmt.Errorf("elevenlabs: dial: %w", err)
	}
	conn.SetReadLimit(maxFrameBytes)

	frame, err := EncodeInitData(opts.Init)
	if err != nil {
		conn.CloseNow()
		return nil, err
	}
	if err := conn.Write(hsCtx, websocket.MessageText, frame); err != nil {
		conn.CloseNow()
		return nil, fmt.Errorf("elevenlabs: send init: %w", err)
	}

	_, data, err := conn.Read(hsCtx)
	if err != nil {
		conn.CloseNow()
		return nil, fmt.Errorf("elevenlabs: read metadata: %w", err)
	}
	ev, err := ParseServerEvent(data)
	if err != nil {
		conn.CloseNow()
		return nil, err
	}
	switch m := ev.(type) {
	case InitMetadata:
		if m.UserInputAudioFormat != in || m.AgentOutputAudioFormat != out {
			conn.CloseNow()
			return nil, fmt.Errorf("elevenlabs: audio format mismatch: got in=%s out=%s want in=%s out=%s",
				m.UserInputAudioFormat, m.AgentOutputAudioFormat, in, out)
		}
		return newConversation(ctx, conn, m), nil
	case ClientError:
		conn.CloseNow()
		return nil, fmt.Errorf("elevenlabs: handshake rejected: %s: %s", m.ErrorName, m.Message)
	default:
		conn.CloseNow()
		return nil, fmt.Errorf("elevenlabs: handshake: unexpected first frame %T", ev)
	}
}

// signedURL fetches a fresh websocket URL for one call.
func (c *Client) signedURL(ctx context.Context) (string, error) {
	q := url.Values{"agent_id": {c.AgentID}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL()+"/v1/convai/conversation/get-signed-url?"+q.Encode(), nil)
	if err != nil {
		return "", fmt.Errorf("elevenlabs: signed url request: %w", err)
	}
	req.Header.Set("xi-api-key", c.APIKey)
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return "", fmt.Errorf("elevenlabs: signed url fetch: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", fmt.Errorf("elevenlabs: signed url fetch: status %d: %s", resp.StatusCode, body)
	}
	var out struct {
		SignedURL string `json:"signed_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("elevenlabs: signed url response: %w", err)
	}
	if out.SignedURL == "" {
		return "", fmt.Errorf("elevenlabs: signed url response missing signed_url")
	}
	return out.SignedURL, nil
}

// baseURL returns BaseURL or the production default.
func (c *Client) baseURL() string {
	if c.BaseURL != "" {
		return c.BaseURL
	}
	return defaultBaseURL
}

// httpClient returns HTTPClient or the shared default client.
func (c *Client) httpClient() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return http.DefaultClient
}
