package elevenlabs

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
)

// Event is one frame received from the server.
type Event interface{ eventType() string }

// InitMetadata announces the conversation id and the audio formats.
type InitMetadata struct {
	ConversationID         string `json:"conversation_id"`
	AgentOutputAudioFormat string `json:"agent_output_audio_format"`
	UserInputAudioFormat   string `json:"user_input_audio_format"`
}

func (InitMetadata) eventType() string { return "conversation_initiation_metadata" }

// AudioEvent is agent speech as raw PCM.
type AudioEvent struct {
	PCM     []byte
	EventID int
}

func (AudioEvent) eventType() string { return "audio" }

// Interruption means the caller started talking over the agent.
type Interruption struct {
	EventID int    `json:"event_id"`
	Reason  string `json:"reason"`
}

func (Interruption) eventType() string { return "interruption" }

// UserTranscript is what the caller just said.
type UserTranscript struct {
	Text    string `json:"user_transcript"`
	EventID int    `json:"event_id"`
}

func (UserTranscript) eventType() string { return "user_transcript" }

// AgentResponse is the text the agent is about to speak.
type AgentResponse struct {
	Text    string `json:"agent_response"`
	EventID int    `json:"event_id"`
}

func (AgentResponse) eventType() string { return "agent_response" }

// AgentResponseCorrection is what the agent managed to say before being cut off.
type AgentResponseCorrection struct {
	Original  string `json:"original_agent_response"`
	Corrected string `json:"corrected_agent_response"`
	EventID   int    `json:"event_id"`
}

func (AgentResponseCorrection) eventType() string { return "agent_response_correction" }

// ClientError is a fatal error from the server.
type ClientError struct {
	Code      int    `json:"code"`
	ErrorName string `json:"error_name"`
	Message   string `json:"message"`
}

func (ClientError) eventType() string { return "client_error" }

// pingEvent is a keepalive check from the server.
type pingEvent struct {
	EventID int `json:"event_id"`
}

func (pingEvent) eventType() string { return "ping" }

// UnknownEvent is any frame type this package does not model.
type UnknownEvent struct {
	Type string
	Raw  []byte
}

func (u UnknownEvent) eventType() string { return u.Type }

// serverEnvelope is the outer shape of every server frame.
type serverEnvelope struct {
	Type           string                   `json:"type"`
	InitMetadata   *InitMetadata            `json:"conversation_initiation_metadata_event"`
	Audio          *audioEventWire          `json:"audio_event"`
	Ping           *pingEvent               `json:"ping_event"`
	Interruption   *Interruption            `json:"interruption_event"`
	UserTranscript *UserTranscript          `json:"user_transcription_event"`
	AgentResponse  *AgentResponse           `json:"agent_response_event"`
	Correction     *AgentResponseCorrection `json:"agent_response_correction_event"`
	ClientError    *ClientError             `json:"error_event"`
}

// audioEventWire is the audio payload before base64 decoding.
type audioEventWire struct {
	AudioBase64 string `json:"audio_base_64"`
	EventID     int    `json:"event_id"`
}

// ParseServerEvent decodes one server frame.
func ParseServerEvent(data []byte) (Event, error) {
	var env serverEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, fmt.Errorf("elevenlabs: malformed server frame: %w", err)
	}
	switch env.Type {
	case "conversation_initiation_metadata":
		if env.InitMetadata == nil {
			return nil, errMissingPayload(env.Type, "conversation_initiation_metadata_event")
		}
		return *env.InitMetadata, nil
	case "audio":
		if env.Audio == nil {
			return nil, errMissingPayload(env.Type, "audio_event")
		}
		pcm, err := base64.StdEncoding.DecodeString(env.Audio.AudioBase64)
		if err != nil {
			return nil, fmt.Errorf("elevenlabs: audio event %d: %w", env.Audio.EventID, err)
		}
		return AudioEvent{PCM: pcm, EventID: env.Audio.EventID}, nil
	case "ping":
		if env.Ping == nil {
			return nil, errMissingPayload(env.Type, "ping_event")
		}
		return *env.Ping, nil
	case "interruption":
		// A bare interruption frame still counts.
		if env.Interruption == nil {
			return Interruption{}, nil
		}
		return *env.Interruption, nil
	case "user_transcript":
		if env.UserTranscript == nil {
			return nil, errMissingPayload(env.Type, "user_transcription_event")
		}
		return *env.UserTranscript, nil
	case "agent_response":
		if env.AgentResponse == nil {
			return nil, errMissingPayload(env.Type, "agent_response_event")
		}
		return *env.AgentResponse, nil
	case "agent_response_correction":
		if env.Correction == nil {
			return nil, errMissingPayload(env.Type, "agent_response_correction_event")
		}
		return *env.Correction, nil
	case "client_error":
		if env.ClientError == nil {
			return nil, errMissingPayload(env.Type, "error_event")
		}
		return *env.ClientError, nil
	default:
		return UnknownEvent{Type: env.Type, Raw: bytes.Clone(data)}, nil
	}
}

func errMissingPayload(typ, key string) error {
	return fmt.Errorf("elevenlabs: %s frame missing %s payload", typ, key)
}

// InitData is the first frame the client sends.
type InitData struct {
	ConfigOverride   *ConfigOverride `json:"conversation_config_override,omitempty"`
	DynamicVariables map[string]any  `json:"dynamic_variables,omitempty"`
	UserID           string          `json:"user_id,omitempty"`
}

// ConfigOverride adjusts the agent's settings for one call.
type ConfigOverride struct {
	Agent *AgentOverride `json:"agent,omitempty"`
	TTS   *TTSOverride   `json:"tts,omitempty"`
}

type AgentOverride struct {
	FirstMessage string `json:"first_message,omitempty"`
	Language     string `json:"language,omitempty"`
}

type TTSOverride struct {
	VoiceID string `json:"voice_id,omitempty"`
}

// EncodeInitData builds the conversation_initiation_client_data frame.
func EncodeInitData(d InitData) ([]byte, error) {
	return json.Marshal(struct {
		Type string `json:"type"`
		InitData
	}{Type: "conversation_initiation_client_data", InitData: d})
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
