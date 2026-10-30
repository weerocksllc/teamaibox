package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"teamaibox.local/node-agent/internal/agent"
)

func fileOperationID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = b[6]&15 | 64
	b[8] = b[8]&63 | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func probeFilesDriver(ctx context.Context, c *agent.PhoneCoordinator, p agent.PhoneCommandPayload, retained bool) (map[string]any, error) {
	content := bytes.Repeat([]byte("synthetic-file-"+p.PhoneID+"\x00\xff"), 4096)
	sum := sha256.Sum256(content)
	digest := hex.EncodeToString(sum[:])
	call := func(action string, source []byte) (map[string]any, []byte, error) {
		command := p
		command.OperationID = fileOperationID()
		payload := agent.PhoneFilePayload{PhoneCommandPayload: command, Action: action, Deadline: time.Now().Add(100 * time.Second).UnixMilli()}
		if action != "list" {
			payload.Name = "driver-check.bin"
		}
		if action == "upload" {
			payload.SizeBytes = int64(len(content))
			payload.SHA256 = digest
			source = append(bytes.Clone(source), []byte("\nTEAMAIBOX-FILE-END\n")...)
		}
		var output bytes.Buffer
		if err := c.TransferPhoneFile(ctx, payload, bytes.NewReader(source), &output); err != nil {
			return nil, nil, err
		}
		line, tail, ok := bytes.Cut(output.Bytes(), []byte{'\n'})
		var value map[string]any
		if !ok || json.Unmarshal(line, &value) != nil || value["phoneId"] != p.PhoneID || value["runId"] != p.Run.ID || value["generation"] != float64(p.Generation) || value["transferId"] != command.OperationID {
			return nil, nil, errors.New("file_driver_response_invalid")
		}
		return value, tail, nil
	}
	if !retained {
		value, _, err := call("upload", content)
		if err != nil {
			return nil, err
		}
		if value["stored"] != true || value["sha256"] != digest {
			return nil, errors.New("file_driver_upload_failed")
		}
	}
	value, tail, err := call("download", nil)
	if err != nil {
		return nil, err
	}
	if value["sha256"] != digest || value["sizeBytes"] != float64(len(content)) || !bytes.Equal(tail, append(bytes.Clone(content), []byte("\nTEAMAIBOX-FILE-END\n")...)) {
		return nil, errors.New("file_driver_download_failed")
	}
	listed, _, err := call("list", nil)
	if err != nil {
		return nil, err
	}
	files, ok := listed["files"].([]any)
	if !ok || len(files) != 1 {
		return nil, errors.New("file_driver_list_failed")
	}
	bad := p
	bad.OwnerID = fileOperationID()
	bad.OperationID = fileOperationID()
	var rejected bytes.Buffer
	if c.TransferPhoneFile(ctx, agent.PhoneFilePayload{PhoneCommandPayload: bad, Action: "list", Deadline: time.Now().Add(time.Minute).UnixMilli()}, bytes.NewReader(nil), &rejected) == nil || rejected.Len() != 0 {
		return nil, errors.New("file_driver_foreign_owner_accepted")
	}
	return map[string]any{"uploadDownloadSHA256": digest, "bytes": len(content), "listed": true, "foreignOwnerDenied": true, "retained": retained, "publicAPIValidated": false}, nil
}
