package extract

import "testing"

// TestChatChannel pins the SayText2 MsgName → channel mapping — the ONLY
// channel signal in the demo stream (demoinfocs' events.ChatMessage has
// IsChatAll hardcoded false and its SayText2 dispatcher silently drops the
// team MsgNames, so the channel is read straight off SayText2.MsgName).
//
// The vocabulary is the one demoinfocs switches on in net_messages.go;
// golden/*.dem.zst contains ONLY Cstrike_Chat_All and Cstrike_Chat_AllDead
// (MsgName census over the golden pool — no team message exists in any of
// them, so [T]/[CT] never renders from golden data).
//
// One row per message is structural, not asserted here: the SayText2
// handler is the single chat-row source (the events.ChatMessage handler
// was removed — ChatMessage has exactly ONE dispatch site, inside
// handleMessageSayText2 for the same message at the same tick, so
// handling both would double every all-chat row). The end-to-end guard is
// the golden acceptance fixture (internal/integration: chat = 34 rows for
// de_cache — it would read 68 if rows ever duplicated).
func TestChatChannel(t *testing.T) {
	cases := []struct {
		msgName string
		want    string
	}{
		{"Cstrike_Chat_All", "all"},
		{"Cstrike_Chat_AllSpec", "all"},
		{"Cstrike_Chat_AllDead", "all"},
		{"Cstrike_Chat_T_Loc", "team"},
		{"Cstrike_Chat_CT_Loc", "team"},
		{"Cstrike_Chat_T_Dead", "team"},
		{"Cstrike_Chat_CT_Dead", "team"},
		// Not chat — never a row (coach join, name change, unknown).
		{"#CSGO_Coach_Join_T", ""},
		{"#Cstrike_Name_Change", ""},
		{"Something_Unknown", ""},
		{"", ""},
	}
	for _, c := range cases {
		if got := chatChannel(c.msgName); got != c.want {
			t.Errorf("chatChannel(%q) = %q, want %q", c.msgName, got, c.want)
		}
	}
}
