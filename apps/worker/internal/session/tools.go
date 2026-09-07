package session

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/ayukumar261/ringback/apps/worker/internal/agent"
)

// runTool executes one agent tool against the room and returns what to tell the agent and how long to hold the reply.
func runTool(rm roomHandle, call agent.Tool) (string, time.Duration, error) {
	switch call.Name {
	case "send_dtmf":
		var p struct {
			Digits string `json:"digits"`
		}
		if err := json.Unmarshal(call.Params, &p); err != nil {
			return "", 0, fmt.Errorf("send_dtmf: bad params: %w", err)
		}
		if err := rm.SendDTMF(p.Digits); err != nil {
			return "", 0, err
		}
		// LiveKit SIP plays each key as a 250ms tone followed by a 250ms rest.
		hold := time.Duration(len(p.Digits)) * 500 * time.Millisecond
		return "pressed " + p.Digits, hold, nil
	default:
		return "", 0, fmt.Errorf("unknown tool %q", call.Name)
	}
}
