package metrics

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// An identity metric's statement names its winner in idkey: that key is the stored
// value_key (the overview reads it). A numeric statement has no identity column: ”.
func TestRawResultRowsStoresTheIdentityKey(t *testing.T) {
	res := store.ROResult{
		Columns: []string{"subject_key", "dim", "value", "idkey"},
		Rows:    [][]any{{"", "", 25.0, "76561198296382419"}},
	}
	rows, err := rawResultRows(res)
	if err != nil {
		t.Fatalf("rawResultRows: %v", err)
	}
	if len(rows) != 1 || rows[0].ValueKey != "76561198296382419" {
		t.Fatalf("identity key not kept: %+v", rows)
	}
}

func TestRawResultRowsNumericHasNoIdentityKey(t *testing.T) {
	res := store.ROResult{
		Columns: []string{"subject_key", "dim", "value"},
		Rows:    [][]any{{"76561198296382419", "", 7.0}},
	}
	rows, err := rawResultRows(res)
	if err != nil {
		t.Fatalf("rawResultRows: %v", err)
	}
	if len(rows) != 1 || rows[0].ValueKey != "" {
		t.Fatalf("numeric row carries a key: %+v", rows)
	}
}
