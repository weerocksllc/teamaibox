package phonepool

// Logical room in a sparse encrypted volume is not physical free capacity.
func boundedPhysicalAvailability(poolFree, backingFree uint64) uint64 {
	if backingFree < poolFree {
		return backingFree
	}
	return poolFree
}
