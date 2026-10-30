package phonepool

import "testing"

func TestElasticCapacityUsesPhysicalAvailability(t *testing.T) {
	for _, c := range []struct{ pool, host, want uint64 }{{4 << 40, 2 << 40, 2 << 40}, {1 << 40, 2 << 40, 1 << 40}, {4 << 40, 0, 0}, {0, 4 << 40, 0}} {
		if got := boundedPhysicalAvailability(c.pool, c.host); got != c.want {
			t.Fatalf("got %d want %d", got, c.want)
		}
	}
}
