package elevenlabs

import (
	"reflect"
	"testing"
)

var parseGolden = []struct {
	name string
	json string
	want Event
}{
	{
		name: "conversation_initiation_metadata",
		json: `{
			"type": "conversation_initiation_metadata",
			"conversation_initiation_metadata_event": {
				"conversation_id": "conv_abc123",
				"agent_output_audio_format": "pcm_48000",
				"user_input_audio_format": "pcm_48000"
			}
		}`,
		want: InitMetadata{
			ConversationID:         "conv_abc123",
			AgentOutputAudioFormat: "pcm_48000",
			UserInputAudioFormat:   "pcm_48000",
		},
	},
	{
		name: "audio minimal",
		json: `{
			"type": "audio",
			"audio_event": {
				"audio_base_64": "UklGRg==",
				"event_id": 7
			}
		}`,
		want: AudioEvent{PCM: []byte("RIFF"), EventID: 7},
	},
	{
		name: "audio with alignment and is_final dropped",
		json: `{
			"type": "audio",
			"audio_event": {
				"audio_base_64": "SGk=",
				"event_id": 1,
				"alignment": {
					"chars": ["H", "i"],
					"char_start_times_ms": [0, 100],
					"char_durations_ms": [100, 150]
				},
				"is_final": false
			}
		}`,
		want: AudioEvent{PCM: []byte("Hi"), EventID: 1},
	},
	{
		name: "ping",
		json: `{"type": "ping", "ping_event": {"event_id": 42, "ping_ms": 50}}`,
		want: pingEvent{EventID: 42},
	},
	{
		name: "interruption with event_id (API reference shape)",
		json: `{"type": "interruption", "interruption_event": {"event_id": 12}}`,
		want: Interruption{EventID: 12},
	},
	{
		name: "interruption with reason (guide shape)",
		json: `{"type": "interruption", "interruption_event": {"reason": "user interrupt"}}`,
		want: Interruption{Reason: "user interrupt"},
	},
	{
		name: "interruption with both fields",
		json: `{"type": "interruption", "interruption_event": {"event_id": 12, "reason": "user interrupt"}}`,
		want: Interruption{EventID: 12, Reason: "user interrupt"},
	},
	{
		name: "interruption with empty payload",
		json: `{"type": "interruption", "interruption_event": {}}`,
		want: Interruption{},
	},
	{
		name: "interruption with no payload survives",
		json: `{"type": "interruption"}`,
		want: Interruption{},
	},
	{
		name: "user_transcript",
		json: `{"type": "user_transcript", "user_transcription_event": {"user_transcript": "I'd like to check my order", "event_id": 3}}`,
		want: UserTranscript{Text: "I'd like to check my order", EventID: 3},
	},
	{
		name: "user_transcript without event_id (guide shape)",
		json: `{"type": "user_transcript", "user_transcription_event": {"user_transcript": "hello"}}`,
		want: UserTranscript{Text: "hello"},
	},
	{
		name: "agent_response",
		json: `{"type": "agent_response", "agent_response_event": {"agent_response": "Sure, can I get your order number?", "event_id": 4}}`,
		want: AgentResponse{Text: "Sure, can I get your order number?", EventID: 4},
	},
	{
		name: "agent_response_correction",
		json: `{
			"type": "agent_response_correction",
			"agent_response_correction_event": {
				"original_agent_response": "Sure, can I get your order number?",
				"corrected_agent_response": "Sure, can I get your—",
				"event_id": 5
			}
		}`,
		want: AgentResponseCorrection{
			Original:  "Sure, can I get your order number?",
			Corrected: "Sure, can I get your—",
			EventID:   5,
		},
	},
	{
		name: "client_error nests under error_event",
		json: `{"type": "client_error", "error_event": {"code": 1008, "error_name": "rate_limited", "message": "Too many concurrent conversations"}}`,
		want: ClientError{Code: 1008, ErrorName: "rate_limited", Message: "Too many concurrent conversations"},
	},
	{
		name: "client_error without optional message",
		json: `{"type": "client_error", "error_event": {"code": 1000, "error_name": "internal_error"}}`,
		want: ClientError{Code: 1000, ErrorName: "internal_error"},
	},
	{
		name: "vad_score is unknown in v1",
		json: `{"type": "vad_score", "vad_score_event": {"vad_score": 0.95}}`,
		want: UnknownEvent{Type: "vad_score"},
	},
	{
		name: "client_tool_call is unknown in v1",
		json: `{
			"type": "client_tool_call",
			"client_tool_call": {
				"tool_name": "search",
				"tool_call_id": "call_123",
				"parameters": {"query": "weather"},
				"event_id": 5,
				"expects_response": true
			}
		}`,
		want: UnknownEvent{Type: "client_tool_call"},
	},
	{
		name: "future event type",
		json: `{"type": "totally_new_event", "some_new_payload": {"x": 1}}`,
		want: UnknownEvent{Type: "totally_new_event"},
	},
}

func TestParseServerEventGolden(t *testing.T) {
	for _, tt := range parseGolden {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseServerEvent([]byte(tt.json))
			if err != nil {
				t.Fatalf("ParseServerEvent: %v", err)
			}
			want := tt.want
			if u, ok := want.(UnknownEvent); ok {
				u.Raw = []byte(tt.json)
				want = u
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("got %#v\nwant %#v", got, want)
			}
		})
	}
}

func TestParseServerEventErrors(t *testing.T) {
	tests := []struct{ name, json string }{
		{"empty input", ``},
		{"truncated frame", `{"type":"audio","audio_event":`},
		{"non-object frame", `[1,2,3]`},
		{"audio missing payload", `{"type":"audio"}`},
		{"audio invalid base64", `{"type":"audio","audio_event":{"audio_base_64":"!!!","event_id":9}}`},
		{"ping missing payload", `{"type":"ping"}`},
		{"metadata missing payload", `{"type":"conversation_initiation_metadata"}`},
		{"transcript missing payload", `{"type":"user_transcript"}`},
		{"agent_response missing payload", `{"type":"agent_response"}`},
		{"correction missing payload", `{"type":"agent_response_correction"}`},
		{"client_error missing payload", `{"type":"client_error"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ev, err := ParseServerEvent([]byte(tt.json))
			if err == nil {
				t.Fatalf("want error, got event %#v", ev)
			}
			if ev != nil {
				t.Fatalf("non-nil event %#v alongside error %v", ev, err)
			}
		})
	}
}

func TestEncodeGolden(t *testing.T) {
	tests := []struct {
		name string
		got  func() ([]byte, error)
		want string
	}{
		{
			name: "pong",
			got:  func() ([]byte, error) { return EncodePong(42) },
			want: `{"type":"pong","event_id":42}`,
		},
		{
			name: "audio chunk has no type field",
			got:  func() ([]byte, error) { return EncodeAudioChunk([]byte("Hello world")) },
			want: `{"user_audio_chunk":"SGVsbG8gd29ybGQ="}`,
		},
		{
			name: "audio chunk empty pcm",
			got:  func() ([]byte, error) { return EncodeAudioChunk(nil) },
			want: `{"user_audio_chunk":""}`,
		},
		{
			name: "init data zero value is minimal",
			got:  func() ([]byte, error) { return EncodeInitData(InitData{}) },
			want: `{"type":"conversation_initiation_client_data"}`,
		},
		{
			name: "init data empty map still minimal",
			got: func() ([]byte, error) {
				return EncodeInitData(InitData{DynamicVariables: map[string]any{}})
			},
			want: `{"type":"conversation_initiation_client_data"}`,
		},
		{
			name: "init data with user id only",
			got: func() ([]byte, error) {
				return EncodeInitData(InitData{UserID: "caller-42"})
			},
			want: `{"type":"conversation_initiation_client_data","user_id":"caller-42"}`,
		},
		{
			name: "init data full",
			got: func() ([]byte, error) {
				return EncodeInitData(InitData{
					ConfigOverride: &ConfigOverride{
						Agent: &AgentOverride{FirstMessage: "Hey, thanks for calling."},
					},
					DynamicVariables: map[string]any{"caller_number": "+15551234567"},
					UserID:           "caller-42",
				})
			},
			want: `{"type":"conversation_initiation_client_data","conversation_config_override":{"agent":{"first_message":"Hey, thanks for calling."}},"dynamic_variables":{"caller_number":"+15551234567"},"user_id":"caller-42"}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := tt.got()
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			if string(got) != tt.want {
				t.Fatalf("wire bytes:\n got %s\nwant %s", got, tt.want)
			}
		})
	}
}

func FuzzParseServerEvent(f *testing.F) {
	for _, tt := range parseGolden {
		f.Add([]byte(tt.json))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		ev, err := ParseServerEvent(data)
		if (ev == nil) == (err == nil) {
			t.Fatalf("want exactly one of event/error, got ev=%#v err=%v", ev, err)
		}
	})
}
