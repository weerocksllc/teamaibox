package agent

import "testing"

func TestPhoneUDPJSONRejectsDuplicateAndNestedPolicyValues(t *testing.T) {
	valid := `{"udpPolicy":{"listenAddress":"10.64.0.19","listenPort":24100,"allowedSources":["10.64.0.26/32"]}}`
	if err := rejectPhoneDuplicateKeys([]byte(valid)); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{
		`{"udpPolicy":{"listenPort":24100,"listenPort":24101}}`,
		`{"udpPolicy":{"allowedSources":[],"allowedSources":[]}}`,
		`{"udpPolicy":{},"udpPolicy":{}}`,
		`{"udpPolicy":{"allowedSources":[{"address":"10.64.0.26"}]}}`,
		`{"udpPolicy":{"allowedSources":[["10.64.0.26/32"]]}}`,
		`{"udpPolicy":{"allowedSources":[null]}}`,
		`{"udpPolicy":{"allowedSources":["10.64.0.26/32"]}} {}`,
	} {
		if rejectPhoneDuplicateKeys([]byte(raw)) == nil {
			t.Fatal("invalid policy JSON accepted", raw)
		}
	}
}
