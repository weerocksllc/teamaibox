package main

import (
	"fmt"
	"io"
	"os"

	dockerruntime "teamaibox.local/node-agent/internal/docker"
)

const maximumInspectBytes = 8 << 20

func main() {
	reader := io.LimitReader(os.Stdin, maximumInspectBytes+1)
	raw, err := io.ReadAll(reader)
	if err != nil || len(raw) == 0 || len(raw) > maximumInspectBytes {
		fmt.Fprintln(os.Stderr, "bounded Docker inspect document is required")
		os.Exit(1)
	}
	digest, err := dockerruntime.ComputeApplianceConfigurationDigest(raw)
	for index := range raw {
		raw[index] = 0
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(digest)
}
