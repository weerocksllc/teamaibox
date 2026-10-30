package agent

import "slices"

// Installed by a verified deployment, never accepted from a phone API request.
// This authorizes a host-runtime repair for one disk, not an Android ROM swap.
type PhoneRuntimeMaintenance struct {
	PhoneID              string   `json:"phoneId"`
	OwnerID              string   `json:"ownerId"`
	VolumeID             string   `json:"volumeId"`
	ROMVersionID         string   `json:"romVersionId"`
	FromImageDigest      string   `json:"fromImageDigest"`
	ToImageDigest        string   `json:"toImageDigest"`
	AndroidSystemDigest  string   `json:"androidSystemDigest"`
	PreviousImageDigests []string `json:"previousImageDigests,omitempty"`
}

func ValidPhoneRuntimeMaintenance(current string, additional []string, values []PhoneRuntimeMaintenance) bool {
	seen := map[string]bool{}
	for _, v := range values {
		if !uuidPattern.MatchString(v.PhoneID) || !uuidPattern.MatchString(v.OwnerID) || !uuidPattern.MatchString(v.VolumeID) ||
			v.ROMVersionID == "" || len(v.ROMVersionID) > 128 || !phoneImageID.MatchString(v.AndroidSystemDigest) ||
			v.FromImageDigest == v.ToImageDigest || !PhoneImageAllowed(current, additional, v.FromImageDigest) ||
			!PhoneImageAllowed(current, additional, v.ToImageDigest) || seen[v.PhoneID] {
			return false
		}
		seen[v.PhoneID] = true
		previous := map[string]bool{}
		for _, image := range v.PreviousImageDigests {
			if image == v.ToImageDigest || previous[image] || !PhoneImageAllowed(current, additional, image) {
				return false
			}
			previous[image] = true
		}
	}
	return true
}

func (c *PhoneCoordinator) allowsHostRepair(action string, old phoneRecord, p PhoneCommandPayload) bool {
	if action != "start" || old.Phase != "stopped" || p.Generation <= old.Generation || old.Run == nil || p.Run == nil ||
		old.Run.ID == p.Run.ID || old.Run.ReservationID == p.Run.ReservationID {
		return false
	}
	for _, v := range c.policy.RuntimeMaintenance {
		if v.PhoneID == p.PhoneID && v.OwnerID == p.OwnerID && v.VolumeID == p.VolumeID &&
			(v.FromImageDigest == old.Run.ImageDigest || slices.Contains(v.PreviousImageDigests, old.Run.ImageDigest)) && v.ToImageDigest == p.Run.ImageDigest {
			return true
		}
	}
	return false
}
