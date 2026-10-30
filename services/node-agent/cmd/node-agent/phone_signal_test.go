package main

import (
	"context"
	"io"
	"net"
	"strings"
	"teamaibox.local/node-agent/internal/agent"
	"testing"
)

type signalDelegateFixture struct {
	commandServiceFixture
	opened, closed int
}

type fileADBDelegateFixture struct {
	signalDelegateFixture
	files, adb       int
	expired          bool
	receivedEnvelope agent.CommandEnvelope
	receivedProof    agent.AuthProof
}

func (s *fileADBDelegateFixture) PhoneSignalLive(agent.PhoneMediaPayload) bool { return !s.expired }
func (s *fileADBDelegateFixture) TransferPhoneFile(_ context.Context, e agent.CommandEnvelope, p agent.AuthProof, in io.Reader, out io.Writer) error {
	s.files++
	s.receivedEnvelope, s.receivedProof = e, p
	_, err := io.Copy(out, in)
	return err
}
func (s *fileADBDelegateFixture) OpenPhoneADB(context.Context, agent.PhoneMediaPayload) (net.Conn, error) {
	s.adb++
	a, b := net.Pipe()
	b.Close()
	return a, nil
}

func TestRestrictedServicePreservesFileEnvelopeAndStreamOnlyWithExactPermission(t *testing.T) {
	for _, allowed := range []bool{false, true} {
		d := &fileADBDelegateFixture{}
		raw := "appliance.inspect"
		if allowed {
			raw = "android-phone.file.transfer"
		}
		s, err := restrictedCommandService(d, raw)
		if err != nil {
			t.Fatal(err)
		}
		bridge, ok := s.(phoneFileDelegate)
		if !ok {
			t.Fatal("production wrapper lost file interface")
		}
		e := agent.CommandEnvelope{Type: "android-phone.file.transfer"}
		p := agent.AuthProof{KeyID: "fixture", Nonce: "fixture-nonce"}
		var output strings.Builder
		err = bridge.TransferPhoneFile(context.Background(), e, p, strings.NewReader("synthetic-file"), &output)
		if (err == nil) != allowed {
			t.Fatal("incorrect file permission", err)
		}
		if allowed && (d.files != 1 || output.String() != "synthetic-file" || d.receivedEnvelope.Type != e.Type || d.receivedProof.Nonce != p.Nonce) {
			t.Fatal("envelope/stream lost")
		}
		if !allowed && (d.files != 0 || output.Len() != 0) {
			t.Fatal("forbidden file delegate called")
		}
		e.Type = "appliance.inspect"
		if bridge.TransferPhoneFile(context.Background(), e, p, strings.NewReader("x"), io.Discard) == nil {
			t.Fatal("wrong command accepted")
		}
	}
	s, _ := restrictedCommandService(commandServiceFixture{}, "android-phone.file.transfer")
	if s.(phoneFileDelegate).TransferPhoneFile(context.Background(), agent.CommandEnvelope{Type: "android-phone.file.transfer"}, agent.AuthProof{}, strings.NewReader("x"), io.Discard) == nil {
		t.Fatal("missing delegate accepted")
	}
}

func TestRestrictedServicePreservesADBOnlyWithCurrentDebugGrant(t *testing.T) {
	for _, scenario := range []string{"allowed", "denied", "expired", "control"} {
		t.Run(scenario, func(t *testing.T) {
			d := &fileADBDelegateFixture{expired: scenario == "expired"}
			raw := "android-phone.media.renew"
			if scenario == "denied" {
				raw = "appliance.inspect"
			}
			s, _ := restrictedCommandService(d, raw)
			p := agent.PhoneMediaPayload{Kind: "adb"}
			if scenario == "control" {
				p.Kind = "control"
			}
			conn, err := s.(phoneADBDelegate).OpenPhoneADB(context.Background(), p)
			if (err == nil) != (scenario == "allowed") {
				t.Fatal("wrong ADB authorization", err)
			}
			if conn != nil {
				conn.Close()
			}
			if scenario != "allowed" && d.adb != 0 {
				t.Fatal("forbidden delegate called")
			}
		})
	}
	s, _ := restrictedCommandService(commandServiceFixture{}, "android-phone.media.renew")
	if _, err := s.(phoneADBDelegate).OpenPhoneADB(context.Background(), agent.PhoneMediaPayload{Kind: "adb"}); err == nil {
		t.Fatal("missing delegate accepted")
	}
}

func (s *signalDelegateFixture) PhoneSignalEndpoint(context.Context, agent.PhoneMediaPayload) (agent.PhoneSignalEndpoint, error) {
	s.opened++
	return agent.PhoneSignalEndpoint{Port: 8463}, nil
}
func (s *signalDelegateFixture) PhoneSignalLive(agent.PhoneMediaPayload) bool { return true }
func (s *signalDelegateFixture) DisconnectPhoneSignal(context.Context, agent.PhoneMediaPayload) {
	s.closed++
}

func TestRestrictedCommandServicePreservesOnlyExplicitlyPermittedPhoneSignal(t *testing.T) {
	for _, allowed := range []bool{false, true} {
		delegate := &signalDelegateFixture{}
		raw := "protected-set.transaction.inspect"
		if allowed {
			raw = "android-phone.media.open,android-phone.media.renew,android-phone.media.close"
		}
		service, err := restrictedCommandService(delegate, raw)
		if err != nil {
			t.Fatal(err)
		}
		bridge, ok := service.(phoneSignalDelegate)
		if !ok {
			t.Fatal("production wrapper lost phone signal interface")
		}
		p := agent.PhoneMediaPayload{}
		if bridge.PhoneSignalLive(p) != allowed {
			t.Fatal("incorrect signal permission")
		}
		_, err = bridge.PhoneSignalEndpoint(context.Background(), p)
		if (err == nil) != allowed {
			t.Fatal("incorrect endpoint permission")
		}
		bridge.DisconnectPhoneSignal(context.Background(), p)
		if allowed && (delegate.opened != 1 || delegate.closed != 1) || !allowed && (delegate.opened != 0 || delegate.closed != 0) {
			t.Fatal("wrong delegate calls")
		}
	}
	service, _ := restrictedCommandService(commandServiceFixture{}, "android-phone.media.renew")
	bridge := service.(phoneSignalDelegate)
	if bridge.PhoneSignalLive(agent.PhoneMediaPayload{}) {
		t.Fatal("non-media service accepted")
	}
}
