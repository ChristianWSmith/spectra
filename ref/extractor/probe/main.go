package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"sync/atomic"

	demoinfocs "github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v6/pkg/demoinfocs/msg"
)

func main() {
	f, err := os.Open("/home/christian/Programming/demo/demo.dem")
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()

	var voice, enc, demoUserCmd, casters atomic.Int64
	xuids := map[uint64]int{}

	p := demoinfocs.NewParser(f)
	defer p.Close()

	p.RegisterNetMessageHandler(func(m *msg.CSVCMsg_VoiceData) {
		voice.Add(1)
		xuids[m.GetXuid()]++
		if m.GetCaster() {
			casters.Add(1)
		}
	})
	p.RegisterNetMessageHandler(func(m *msg.CSVCMsg_EncryptedData) {
		enc.Add(1)
	})
	p.RegisterNetMessageHandler(func(m *msg.CDemoUserCmd) {
		demoUserCmd.Add(1)
	})

	if err := p.ParseToEnd(context.Background()); err != nil {
		fmt.Println("parse note:", err)
	}

	fmt.Printf("VoiceData msgs: %d (caster: %d) unique XUIDs: %d\n", voice.Load(), casters.Load(), len(xuids))
	for x, c := range xuids {
		fmt.Printf("  xuid=%d chunks=%d\n", x, c)
	}
	fmt.Printf("EncryptedData msgs: %d\n", enc.Load())
	fmt.Printf("DemoUserCmd frames: %d\n", demoUserCmd.Load())
}
