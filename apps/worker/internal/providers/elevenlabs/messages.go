package elevenlabs

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/ayukumar261/ringback/apps/worker/internal/agent"
)

// InitMetadata announces the conversation id and the audio formats.
type InitMetadata struct {
	ConversationID         string `json:"conversation_id"`
	AgentOutputAudioFormat string `json:"agent_output_audio_format"`
	UserInputAudioFormat   string `json:"user_input_audio_format"`
}

// pingEvent is a keepalive check from the server.
type pingEvent struct {
	EventID int `json:"event_id"`
}

// audioEventWire is the audio payload before base64 decoding.
type audioEventWire struct {
	AudioBase64 string `json:"audio_base_64"`
	EventID     int    `json:"event_id"`
}

// interruptionWire is the interruption payload as sent by the server.
type interruptionWire struct {
	EventID int    `json:"event_id"`
	Reason  string `json:"reason"`
}

// transcriptWire is the user transcript payload as sent by the server.
type transcriptWire struct {
	Text    string `json:"user_transcript"`
	EventID int    `json:"event_id"`
}

// responseWire is the agent response payload as sent by the server.
type responseWire struct {
	Text    string `json:"agent_response"`
	EventID int    `json:"event_id"`
}

// correctionWire is the agent response correction payload as sent by the server.
type correctionWire struct {
	Original  string `json:"original_agent_response"`
	Corrected string `json:"corrected_agent_response"`
	EventID   int    `json:"event_id"`
}

// errorWire is the fatal error payload as sent by the server.
type errorWire struct {
	Code      int    `json:"code"`
	ErrorName string `json:"error_name"`
	Message   string `json:"message"`
}

// toolCallWire is the client tool call payload as sent by the server.
type toolCallWire struct {
	ToolName   string          `json:"tool_name"`
	ToolCallID string          `json:"tool_call_id"`
	Parameters json.RawMessage `json:"parameters"`
	EventID    int             `json:"event_id"`
}

// serverEnvelope is the outer shape of every server frame.
type serverEnvelope struct {
	Type           string            `json:"type"`
	InitMetadata   *InitMetadata     `json:"conversation_initiation_metadata_event"`
	Audio          *audioEventWire   `json:"audio_event"`
	Ping           *pingEvent        `json:"ping_event"`
	Interruption   *interruptionWire `json:"interruption_event"`
	UserTranscript *transcriptWire   `json:"user_transcription_event"`
	AgentResponse  *responseWire     `json:"agent_response_event"`
	Correction     *correctionWire   `json:"agent_response_correction_event"`
	ClientError    *errorWire        `json:"error_event"`
	ToolCall       *toolCallWire     `json:"client_tool_call"`
}

// decodeFrame unmarshals the envelope so the transport can intercept control frames.
func decodeFrame(data []byte) (serverEnvelope, error) {
	var env serverEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return serverEnvelope{}, fmt.Errorf("elevenlabs: malformed server frame: %w", err)
	}
	return env, nil
}

// event maps a decoded envelope to the agent event it carries.
func (env serverEnvelope) event(raw []byte) (agent.Event, error) {
	switch env.Type {
	case "audio":
		if env.Audio == nil {
			return nil, errMissingPayload(env.Type, "audio_event")
		}
		pcm, err := base64.StdEncoding.DecodeString(env.Audio.AudioBase64)
		if err != nil {
			return nil, fmt.Errorf("elevenlabs: audio event %d: %w", env.Audio.EventID, err)
		}
		return agent.Audio{PCM: pcm, EventID: env.Audio.EventID}, nil
	case "interruption":
		// A bare interruption frame still counts.
		if env.Interruption == nil {
			return agent.Interruption{}, nil
		}
		return agent.Interruption{EventID: env.Interruption.EventID, Reason: env.Interruption.Reason}, nil
	case "user_transcript":
		if env.UserTranscript == nil {
			return nil, errMissingPayload(env.Type, "user_transcription_event")
		}
		return agent.UserTurn{Text: env.UserTranscript.Text, EventID: env.UserTranscript.EventID}, nil
	case "agent_response":
		if env.AgentResponse == nil {
			return nil, errMissingPayload(env.Type, "agent_response_event")
		}
		return agent.AgentTurn{Text: env.AgentResponse.Text, EventID: env.AgentResponse.EventID}, nil
	case "agent_response_correction":
		if env.Correction == nil {
			return nil, errMissingPayload(env.Type, "agent_response_correction_event")
		}
		return agent.Correction{
			Original:  env.Correction.Original,
			Corrected: env.Correction.Corrected,
			EventID:   env.Correction.EventID,
		}, nil
	case "client_tool_call":
		if env.ToolCall == nil {
			return nil, errMissingPayload(env.Type, "client_tool_call")
		}
		return agent.Tool{
			ID:     env.ToolCall.ToolCallID,
			Name:   env.ToolCall.ToolName,
			Params: env.ToolCall.Parameters,
		}, nil
	case "client_error":
		if env.ClientError == nil {
			return nil, errMissingPayload(env.Type, "error_event")
		}
		return agent.Error{
			Code:    env.ClientError.Code,
			Name:    env.ClientError.ErrorName,
			Message: env.ClientError.Message,
		}, nil
	default:
		return agent.Unknown{Type: env.Type, Raw: bytes.Clone(raw)}, nil
	}
}

// ParseServerEvent decodes one server frame into the agent event it carries.
func ParseServerEvent(data []byte) (agent.Event, error) {
	env, err := decodeFrame(data)
	if err != nil {
		return nil, err
	}
	return env.event(data)
}

func errMissingPayload(typ, key string) error {
	return fmt.Errorf("elevenlabs: %s frame missing %s payload", typ, key)
}

// initFrame is the first frame the client sends, carrying whatever settings belong to this call.
type initFrame struct {
	Type   string      `json:"type"`
	Config *callConfig `json:"conversation_config_override,omitempty"`
}

// callConfig is the slice of agent settings a call may bring with it.
type callConfig struct {
	Agent *agentConfig `json:"agent,omitempty"`
}

type agentConfig struct {
	Prompt *agentPrompt `json:"prompt,omitempty"`
}

type agentPrompt struct {
	Prompt string `json:"prompt"`
}

// encodeInit builds the conversation_initiation_client_data frame, leaving the dashboard prompt in charge when the call has none.
func encodeInit(s agent.Start) ([]byte, error) {
	f := initFrame{Type: "conversation_initiation_client_data"}
	if s.Prompt != "" {
		f.Config = &callConfig{Agent: &agentConfig{Prompt: &agentPrompt{Prompt: s.Prompt}}}
	}
	return json.Marshal(f)
}

// EncodeAudioChunk builds a user_audio_chunk frame from raw PCM.
func EncodeAudioChunk(pcm []byte) ([]byte, error) {
	return json.Marshal(struct {
		UserAudioChunk string `json:"user_audio_chunk"`
	}{base64.StdEncoding.EncodeToString(pcm)})
}

// EncodePong builds the reply to a server ping.
func EncodePong(eventID int) ([]byte, error) {
	return json.Marshal(struct {
		Type    string `json:"type"`
		EventID int    `json:"event_id"`
	}{Type: "pong", EventID: eventID})
}

// EncodeToolResult builds the client_tool_result frame answering one tool call.
func EncodeToolResult(id, result string, isErr bool) ([]byte, error) {
	return json.Marshal(struct {
		Type       string `json:"type"`
		ToolCallID string `json:"tool_call_id"`
		Result     string `json:"result"`
		IsError    bool   `json:"is_error"`
	}{Type: "client_tool_result", ToolCallID: id, Result: result, IsError: isErr})
}
