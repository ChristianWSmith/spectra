package store

import "testing"

// TestIsBotKeySQL pins the is_bot_key SQL function to the models rule: a
// synthetic 0xFF-prefixed key is a bot, a SteamID64 is not, and a non-number
// (the empty roster key) is not a bot.
func TestIsBotKeySQL(t *testing.T) {
	s, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	cases := []struct {
		in   string
		want int
	}{
		{"18374686479671623692", 1}, // 0xFF00000000000000 | entity 12 (a bot)
		{"18374686479671623680", 1}, // the prefix itself
		{"76561198386265483", 0},    // a SteamID64 human
		{"76561197968389863", 0},
		{"", 0},
		{"not-a-number", 0},
	}
	for _, c := range cases {
		var got int
		if err := s.db.QueryRow(`SELECT is_bot_key(?)`, c.in).Scan(&got); err != nil {
			t.Fatalf("is_bot_key(%q): %v", c.in, err)
		}
		if got != c.want {
			t.Errorf("is_bot_key(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}
