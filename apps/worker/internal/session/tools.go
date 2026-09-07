package session

import (
	"encoding/json"
	"fmt"

	"github.com/ayukumar261/ringback/apps/worker/internal/agent"
)

// runTool executes one agent tool against the room and returns what to tell the agent.
func runTool(rm roomHandle, call agent.Tool) (string, error) {
	switch call.Name {
	case "send_dtmf":
		var p struct {
			Digits string `json:"digits"`
		}
		if err := json.Unmarshal(call.Params, &p); err != nil {
			return "", fmt.Errorf("send_dtmf: bad params: %w", err)
		}
		if err := rm.SendDTMF(p.Digits); err != nil {
			return "", err
		}
		return "pressed " + p.Digits, nil
	default:
		return "", fmt.Errorf("unknown tool %q", call.Name)
	}
}
