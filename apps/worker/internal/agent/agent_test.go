package agent_test

import (
	"testing"

	"github.com/ayukumar261/ringback/apps/worker/internal/agent"
	"github.com/ayukumar261/ringback/apps/worker/internal/providers/elevenlabs"
)

// The ElevenLabs adapter is the one implementation the bridge is handed.
var (
	_ agent.Provider     = (*elevenlabs.Client)(nil)
	_ agent.Conversation = (*elevenlabs.Conversation)(nil)
)

func TestEventVocabulary(t *testing.T) {
	// Every event type the bridge switches on must be part of the sealed set.
	events := []agent.Event{
		agent.Audio{},
		agent.Interruption{},
		agent.UserTurn{},
		agent.AgentTurn{},
		agent.Correction{},
		agent.Error{},
		agent.Unknown{},
		agent.Tool{},
	}
	if len(events) != 8 {
		t.Fatalf("vocabulary has %d events, want 8", len(events))
	}
}
