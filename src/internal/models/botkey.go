package models

// BotKeyPrefix is the high byte of the synthetic accumulator key the
// extractor gives a bot (extract.playerKey): 0xFF<<56 | entity id. Humans
// carry their SteamID64, which never has this prefix.
const BotKeyPrefix = 0xFF

// IsBotKey reports whether an accumulator key (players.steam_id as a number)
// is the synthetic bot key. This is the one definition of the rule; the
// store's is_bot_key() SQL function and the extractor both call it.
func IsBotKey(key uint64) bool {
	return key>>56 == BotKeyPrefix
}
