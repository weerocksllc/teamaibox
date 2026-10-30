package main

import (
	"encoding/json"
	"testing"
)

func TestBuildAdapterAllowsOnlyApprovedTlsUpstreams(t *testing.T) {
	certificate := []byte("-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----")
	for _, upstream := range []string{
		"", "://broken", "http://127.0.0.1:19093", "https://10.64.0.23:19092",
		"https://10.64.0.23:8008", "https://example.com:19093", "https://localhost",
		"https://localhost:0", "https://localhost:65536", "https://localhost:19093/path",
		"https://user:secret@localhost:19093", "https://localhost:19093?target=remote",
		"https://localhost:19093#remote", "https://localhost:19093?",
	} {
		if _, err := buildAdapter([]byte("token"), certificate, upstream); err == nil || err.Error() != "upstream is outside the approved Provider boundary" {
			t.Fatalf("unapproved upstream was not rejected first: %s err=%v", upstream, err)
		}
	}
	for _, upstream := range []string{"https://127.0.0.1:19093", "https://[::1]:19093", "https://localhost:19093", "https://host.docker.internal:19093"} {
		if _, err := buildAdapter([]byte("token"), certificate, upstream); err == nil || err.Error() != "upstream certificate is invalid" {
			t.Fatalf("local upstream did not reach certificate validation: %s err=%v", upstream, err)
		}
	}
}

func requestBody(segments []string) []byte {
	content, _ := json.Marshal(map[string]any{"source_language": "auto", "target_language": "zh-CN", "segments": segments})
	body, _ := json.Marshal(map[string]any{
		"model":           translationModel,
		"response_format": map[string]any{"type": "json_object"},
		"messages":        []map[string]any{{"role": "user", "content": string(content)}},
	})
	return body
}

func TestHardenTranslationRequestBindsExactSegmentCount(t *testing.T) {
	result, count, err := hardenTranslationRequest(requestBody([]string{"one", "two"}))
	if err != nil || count != 2 {
		t.Fatalf("harden failed: count=%d err=%v", count, err)
	}
	var value map[string]any
	if json.Unmarshal(result, &value) != nil {
		t.Fatal("result is not JSON")
	}
	format := value["response_format"].(map[string]any)
	schema := format["json_schema"].(map[string]any)["schema"].(map[string]any)
	translations := schema["properties"].(map[string]any)["translations"].(map[string]any)
	if format["type"] != "json_schema" || translations["minItems"] != float64(2) || translations["maxItems"] != float64(2) {
		t.Fatalf("exact alignment schema drifted: %#v", format)
	}
	if schema["additionalProperties"] != false {
		t.Fatal("additional properties must be denied")
	}
	messages := value["messages"].([]any)
	system := messages[0].(map[string]any)["content"]
	if len(messages) != 2 || system != "Translate every segment precisely. Preserve numbers, codes, product names, and Latin proper nouns. Return only the required aligned JSON." {
		t.Fatalf("translation prompt was not normalized: %#v", messages)
	}
	if value["max_tokens"].(float64) < 256 || value["max_tokens"].(float64) > 2048 {
		t.Fatalf("translation output boundary drifted: %#v", value["max_tokens"])
	}
}

func TestHardenTranslationRequestRejectsInvalidInputs(t *testing.T) {
	cases := [][]byte{
		{},
		[]byte(`{"model":"other","messages":[]}`),
		requestBody(nil),
		requestBody([]string{""}),
	}
	for index, body := range cases {
		if _, _, err := hardenTranslationRequest(body); err == nil {
			t.Fatalf("case %d unexpectedly passed", index)
		}
	}
}

func TestHardenTranslationRequestPreservesGenericContractProbe(t *testing.T) {
	body, _ := json.Marshal(map[string]any{
		"model":    translationModel,
		"messages": []map[string]any{{"role": "user", "content": "Reply with exactly: OK"}},
	})
	result, count, err := hardenTranslationRequest(body)
	if err != nil || count != 0 || string(result) != string(body) {
		t.Fatalf("generic contract probe changed: count=%d err=%v", count, err)
	}
}

func TestAlignedResponseFormatIsStrict(t *testing.T) {
	format := alignedResponseFormat(3)
	value, _ := json.Marshal(format)
	var roundTrip map[string]any
	if json.Unmarshal(value, &roundTrip) != nil {
		t.Fatal("format is not JSON-compatible")
	}
	jsonSchema := roundTrip["json_schema"].(map[string]any)
	if jsonSchema["strict"] != true || jsonSchema["name"] != "translation_result" {
		t.Fatal("strict schema identity drifted")
	}
}

func TestAlignedCompletionValidatesExactCount(t *testing.T) {
	response, _ := json.Marshal(map[string]any{
		"object": "chat.completion",
		"choices": []map[string]any{{"message": map[string]any{
			"content": `{"source_language":"en","translations":["一","二"]}`,
		}}},
		"usage": map[string]any{"prompt_tokens": 4, "completion_tokens": 3, "total_tokens": 7},
	})
	result, valid := alignedCompletion(response, 2)
	if !valid || len(result) == 0 {
		t.Fatal("valid exact-alignment completion was rejected")
	}
	if _, valid := alignedCompletion(response, 3); valid {
		t.Fatal("misaligned completion was accepted")
	}
}

func TestAlignedCompletionDropsInvalidOptionalUsage(t *testing.T) {
	response, _ := json.Marshal(map[string]any{
		"object": "chat.completion",
		"choices": []map[string]any{{"message": map[string]any{
			"content": `{"source_language":"en","translations":["一"]}`,
		}}},
		"usage": map[string]any{"prompt_tokens": 4, "completion_tokens": 3, "total_tokens": 99},
	})
	result, valid := alignedCompletion(response, 1)
	if !valid {
		t.Fatal("completion with optional invalid usage was rejected")
	}
	var document map[string]any
	if json.Unmarshal(result, &document) != nil {
		t.Fatal("normalized completion is not JSON")
	}
	if _, present := document["usage"]; present {
		t.Fatal("invalid optional usage survived normalization")
	}
}
