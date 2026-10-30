package docker

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPhoneUsbInventoryUsesOnlyInstalledLocalSocket(t *testing.T) {
	for _, bad := range []bool{false, true} {
		folder, err := os.MkdirTemp("", "phone-usb-")
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(folder, "camera.sock")
		listener, err := net.Listen("unix", path)
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan map[string]any, 1)
		go func() {
			peer, err := listener.Accept()
			if err != nil {
				return
			}
			defer peer.Close()
			raw, _ := bufio.NewReader(peer).ReadBytes('\n')
			var request map[string]any
			_ = json.Unmarshal(raw, &request)
			done <- request
			node := "node-test"
			if bad {
				node = "another-node"
			}
			_ = json.NewEncoder(peer).Encode(map[string]any{"result": map[string]any{"nodeId": node, "data": []any{}}})
		}()
		driver := &PhoneDriver{policy: PhoneContainerPolicy{NodeID: "node-test", UsbCameraSocket: path}}
		raw, err := driver.PhoneUsbInventory(context.Background())
		if (err != nil) != bad {
			t.Fatalf("bad=%v raw=%s err=%v", bad, raw, err)
		}
		request := <-done
		if len(request) != 3 || request["action"] != "inventory" || request["nodeId"] != "node-test" {
			t.Fatalf("unexpected request: %+v", request)
		}
		listener.Close()
		os.Remove(path)
		os.Remove(folder)
	}
	for _, path := range []string{"", "http://10.64.0.19/camera", "/var/run/docker.sock"} {
		driver := &PhoneDriver{policy: PhoneContainerPolicy{UsbCameraSocket: path}}
		if _, err := driver.PhoneUsbInventory(context.Background()); err == nil || !strings.Contains(err.Error(), "not_configured") {
			t.Fatal("arbitrary endpoint accepted")
		}
	}
}
