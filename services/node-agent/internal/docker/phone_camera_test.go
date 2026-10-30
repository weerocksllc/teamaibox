package docker

import "testing"

func TestCameraWorkerErrorsContainOnlyPublicCodes(t *testing.T) {
	for _, code := range []string{"phone_camera_image_unsupported", "phone_camera_image_too_large", "phone_camera_source_stopped"} {
		if cameraWorkerError([]byte(`{"errorCode":"`+code+`"}`)).Error() != code {
			t.Fatal("safe error lost")
		}
	}
	for _, raw := range []string{`{"errorCode":"/private/image.png"}`, `{"errorCode":"phone_camera_image_unsupported","image":"private"}`, `{"errorCode":"phone_camera_image_unsupported"} {}`, `traceback private contents`} {
		if cameraWorkerError([]byte(raw)).Error() != "phone_camera_worker_failed" {
			t.Fatal("private or malformed diagnostic leaked")
		}
	}
}
