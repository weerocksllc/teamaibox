package docker

import (
	"errors"
	"net"
	"strconv"
	"teamaibox.local/node-agent/internal/agent"
)

const phoneLANProfile = "isolated-egress-lan-v1"

func ValidPhoneControlNetworkID(value string) bool {
	return phoneExactContainerID.MatchString(value)
}

// Instance numbers select disjoint media-port ranges, not a two-phone product
// tier. Stop only when the allocated range no longer fits TCP/UDP port numbers.
func validPhoneInstance(instance int) bool {
	return instance >= 21 && instance <= 21+(65535-20049)/100
}

func ValidPhoneInstanceLimits(current string, additional []string, limits map[string]int) bool {
	for image, last := range limits {
		if !agent.PhoneImageAllowed(current, additional, image) || !validPhoneInstance(last) {
			return false
		}
	}
	return true
}

func (p PhoneContainerPolicy) forInstance(instance int) PhoneContainerPolicy {
	p.Instance = instance
	return p
}

func validPhoneNetworkPolicy(p PhoneContainerPolicy) bool {
	if p.NetworkProfile == "" {
		return p.MediaAddress == "" && p.HostMediaStateFile == ""
	}
	if p.HostMediaStateFile != "" {
		return p.NetworkProfile == phoneLANProfile && phonePrivateRoot(p.HostMediaStateFile)
	}
	ip := net.ParseIP(p.MediaAddress)
	return p.NetworkProfile == phoneLANProfile && ip != nil && ip.To4() != nil && ip.IsPrivate() && ip.String() == p.MediaAddress
}

func applyPhoneNetworkPolicy(config map[string]any, p PhoneContainerPolicy) error {
	if !validPhoneNetworkPolicy(p) {
		return errors.New("phone_network_policy_invalid")
	}
	if p.NetworkProfile == "" {
		return nil
	}
	if !validPhoneInstance(p.Instance) {
		return errors.New("phone_network_instance_invalid")
	}
	config["User"] = "0:0" // Short init drops all powers before starting Android.
	config["Entrypoint"] = []string{"/usr/bin/python3", "/opt/teamaibox/phone_network_start.py"}
	host := config["HostConfig"].(map[string]any)
	// KILL belongs to Docker's PID-1 signal proxy, so it can forward a normal
	// stop to UID 10001. Cuttlefish and all its children drop every capability.
	host["CapAdd"] = []string{"CAP_KILL", "CAP_NET_ADMIN", "CAP_SETGID", "CAP_SETPCAP", "CAP_SETUID"}
	host["Sysctls"] = map[string]string{"net.ipv4.ip_forward": "1", "net.ipv6.conf.all.disable_ipv6": "1",
		"net.ipv4.conf.all.route_localnet": "0", "net.ipv4.conf.default.route_localnet": "0"}
	host["Tmpfs"].(map[string]string)["/run"] = "rw,nosuid,nodev,noexec,size=1048576,mode=0755"
	host["Devices"] = append(host["Devices"].([]map[string]string), map[string]string{
		"PathOnHost": "/dev/net/tun", "PathInContainer": "/dev/net/tun", "CgroupPermissions": "rw"})
	bindings := map[string]any{}
	exposed := map[string]any{}
	first := 20000 + (p.Instance-21)*100
	for port := first; port < first+50; port++ {
		for _, protocol := range []string{"udp", "tcp"} {
			key := strconv.Itoa(port) + "/" + protocol
			if p.HostMediaStateFile == "" {
				bindings[key] = []map[string]string{{"HostIp": p.MediaAddress, "HostPort": strconv.Itoa(port)}}
			}
			exposed[key] = map[string]any{}
		}
	}
	// No operator, ADB, CDP or control socket is published to the LAN.
	host["PortBindings"] = bindings
	config["ExposedPorts"] = exposed
	return nil
}
