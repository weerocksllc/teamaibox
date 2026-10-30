package docker

import (
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestPhoneLANPortsAreSlotBoundAndControlStaysPrivate(t *testing.T) {
	for _, instance := range []int{21, 22, 23, 475} {
		policy, p := phoneRecipeFixture(t)
		policy.NetworkProfile, policy.MediaAddress, policy.Instance = phoneLANProfile, "10.64.0.19", instance
		config, err := buildPhoneContainer(policy, p, strings.Repeat("b", 64))
		if err != nil {
			t.Fatal(err)
		}
		host := config["HostConfig"].(map[string]any)
		ports := host["PortBindings"].(map[string]any)
		if len(ports) != 100 || len(config["ExposedPorts"].(map[string]any)) != 100 {
			t.Fatal("port envelope widened")
		}
		first := 20000 + (instance-21)*100
		for n := first; n < first+50; n++ {
			for _, proto := range []string{"tcp", "udp"} {
				port := strconv.Itoa(n)
				if !reflect.DeepEqual(ports[port+"/"+proto], []map[string]string{{"HostIp": "10.64.0.19", "HostPort": port}}) {
					t.Fatal("port binding drift")
				}
			}
		}
		if config["User"] != "0:0" || host["Memory"] != host["MemorySwap"] || host["ReadonlyRootfs"] != true {
			t.Fatal("runtime envelope drift")
		}
		if len(host["Devices"].([]map[string]string)) != 3 || host["Devices"].([]map[string]string)[2]["PathOnHost"] != "/dev/net/tun" {
			t.Fatal("devices widened")
		}
		normalized := phoneNormalized(config).(map[string]any)
		state := phoneEngineState{ID: strings.Repeat("c", 64), Image: policy.ImageID, Config: normalized, HostConfig: normalized["HostConfig"].(map[string]any)}
		state.State.Status = "created"
		if !exactPhoneContainer(state, policy, p, strings.Repeat("b", 64)) {
			t.Fatal("valid LAN recipe rejected")
		}
		for _, change := range []string{"extra-port", "wildcard", "extra-sysctl", "extra-exposed", "extra-cap", "other-slot"} {
			n := phoneNormalized(config).(map[string]any)
			h := n["HostConfig"].(map[string]any)
			s := state
			s.Config = n
			s.HostConfig = h
			switch change {
			case "extra-port":
				h["PortBindings"].(map[string]any)["8463/tcp"] = []any{}
			case "wildcard":
				h["PortBindings"].(map[string]any)[strconv.Itoa(first)+"/tcp"].([]any)[0].(map[string]any)["HostIp"] = "0.0.0.0"
			case "extra-sysctl":
				h["Sysctls"].(map[string]any)["net.ipv4.conf.eth0.route_localnet"] = "1"
			case "extra-exposed":
				n["ExposedPorts"].(map[string]any)["6520/tcp"] = map[string]any{}
			case "extra-cap":
				h["CapAdd"] = append(h["CapAdd"].([]any), "CAP_SYS_ADMIN")
			case "other-slot":
				h["PortBindings"].(map[string]any)[strconv.Itoa(first)+"/tcp"].([]any)[0].(map[string]any)["HostPort"] = strconv.Itoa(first + 100)
			}
			if exactPhoneContainer(s, policy, p, strings.Repeat("b", 64)) {
				t.Fatal("accepted drift", change)
			}
		}
	}
}

func TestPhoneLANRejectsUninstalledAddressesAndSlots(t *testing.T) {
	for _, address := range []string{"", "0.0.0.0", "127.0.0.1", "1.1.1.1", "169.254.169.254", "fd00::1", "192.168.010.19", "10.64.0.19\n"} {
		policy, p := phoneRecipeFixture(t)
		policy.NetworkProfile = phoneLANProfile
		policy.MediaAddress = address
		policy.Instance = 21
		if _, err := buildPhoneContainer(policy, p, strings.Repeat("b", 64)); err == nil {
			t.Fatal("unsafe media address", address)
		}
	}
	for _, instance := range []int{0, 1, 20, 476, 999999} {
		policy, p := phoneRecipeFixture(t)
		policy.NetworkProfile = phoneLANProfile
		policy.MediaAddress = "10.64.0.19"
		policy.Instance = instance
		if _, err := buildPhoneContainer(policy, p, strings.Repeat("b", 64)); err == nil {
			t.Fatal("unallocated slot", instance)
		}
	}
}

func TestPhoneHostManagedMediaKeepsExactLegacyRecipe(t *testing.T) {
	policy, p := phoneRecipeFixture(t)
	policy.NetworkProfile, policy.MediaAddress, policy.Instance = phoneLANProfile, "10.64.0.20", 21
	network := strings.Repeat("b", 64)
	legacy, err := buildPhoneContainer(policy, p, network)
	if err != nil {
		t.Fatal(err)
	}
	policy.HostMediaStateFile = "/installed/phone-media.json"
	current, err := buildPhoneContainer(policy, p, network)
	if err != nil {
		t.Fatal(err)
	}
	if len(current["HostConfig"].(map[string]any)["PortBindings"].(map[string]any)) != 0 {
		t.Fatal("new guest depends on a bound host address")
	}
	for _, recipe := range []map[string]any{legacy, current} {
		n := phoneNormalized(recipe).(map[string]any)
		state := phoneEngineState{ID: strings.Repeat("c", 64), Image: p.Run.ImageDigest, Config: n, HostConfig: n["HostConfig"].(map[string]any)}
		if !exactPhoneContainer(state, policy, p, network) {
			t.Fatal("exact old/new guest rejected")
		}
		state.HostConfig["PortBindings"] = map[string]any{"8443/tcp": []any{map[string]any{"HostIp": "0.0.0.0", "HostPort": "8443"}}}
		if exactPhoneContainer(state, policy, p, network) {
			t.Fatal("unexpected publication accepted")
		}
	}
}
