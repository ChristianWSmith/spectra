// Command deadscan is a report-only dead-code scan for the Go module. It is
// stdlib-only and never edits anything. Usage:
//
//	go run ./cmd/deadscan [-js frontend/src,frontend/test] [-root .]
//
// For every top-level declaration (func, method, type, var, const) it counts
// identifier occurrences in production files and in _test.go files. A name
// whose production count is 1 (the declaration itself) has no production
// reference. Those names are printed in two groups:
//
//   - dead:      no production and no test reference
//   - test-only: referenced only by tests (often an oracle or test seam; check)
//
// The count is by name, so it is conservative: a same-named identifier
// anywhere keeps a declaration alive. Exported methods bound to the frontend
// (Wails) are invisible to Go alone, so -js lists directories to search for
// names; any name found there is treated as used.
//
// Known intentional patterns the report will still show (verify, do not
// auto-delete): interface-satisfying methods (e.g. http.ResponseWriter),
// test oracles marked "ORACLE" in comments, and symbols an in-flight branch
// is about to use.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// identRe matches identifier-shaped tokens in JavaScript text.
var identRe = regexp.MustCompile(`[A-Za-z_$][A-Za-z0-9_$]*`)

type decl struct {
	file, name, kind string
	line             int
}

func main() {
	root := flag.String("root", ".", "module root to scan")
	jsDirs := flag.String("js", "", "comma-separated directories searched for references from the frontend")
	flag.Parse()

	fset := token.NewFileSet()
	prod := map[string]int{}
	test := map[string]int{}
	var decls []decl

	err := filepath.WalkDir(*root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			n := d.Name()
			if p != *root && (strings.HasPrefix(n, ".") || n == "node_modules" || n == "frontend" || n == "bin" || n == "build") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, ".go") {
			return nil
		}
		f, perr := parser.ParseFile(fset, p, nil, 0)
		if perr != nil {
			return nil
		}
		isTest := strings.HasSuffix(p, "_test.go")
		rel, _ := filepath.Rel(*root, p)
		ast.Inspect(f, func(n ast.Node) bool {
			if id, ok := n.(*ast.Ident); ok {
				if isTest {
					test[id.Name]++
				} else {
					prod[id.Name]++
				}
			}
			return true
		})
		if isTest {
			return nil
		}
		for _, dl := range f.Decls {
			switch x := dl.(type) {
			case *ast.FuncDecl:
				if x.Name.Name == "init" || x.Name.Name == "main" {
					continue
				}
				kind := "func"
				if x.Recv != nil {
					kind = "method"
				}
				decls = append(decls, decl{rel, x.Name.Name, kind, fset.Position(x.Pos()).Line})
			case *ast.GenDecl:
				for _, s := range x.Specs {
					switch sp := s.(type) {
					case *ast.TypeSpec:
						decls = append(decls, decl{rel, sp.Name.Name, "type", fset.Position(sp.Pos()).Line})
					case *ast.ValueSpec:
						for _, nm := range sp.Names {
							if nm.Name != "_" {
								decls = append(decls, decl{rel, nm.Name, strings.ToLower(x.Tok.String()), fset.Position(nm.Pos()).Line})
							}
						}
					}
				}
			}
		}
		return nil
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "deadscan:", err)
		os.Exit(1)
	}

	jsIdents := map[string]bool{}
	if *jsDirs != "" {
		for _, tok := range identRe.FindAllString(readDirs(strings.Split(*jsDirs, ",")), -1) {
			jsIdents[tok] = true
		}
	}

	sort.Slice(decls, func(i, j int) bool {
		if decls[i].file != decls[j].file {
			return decls[i].file < decls[j].file
		}
		return decls[i].line < decls[j].line
	})

	var dead, testOnly []string
	for _, d := range decls {
		if prod[d.name] > 1 {
			continue
		}
		if jsIdents[d.name] {
			continue
		}
		line := fmt.Sprintf("%s:%d  %s %s", d.file, d.line, d.kind, d.name)
		if test[d.name] == 0 {
			dead = append(dead, line)
		} else {
			testOnly = append(testOnly, fmt.Sprintf("%s  (test refs: %d)", line, test[d.name]))
		}
	}

	fmt.Printf("== Go: no production reference and no test reference (%d)\n", len(dead))
	for _, l := range dead {
		fmt.Println(l)
	}
	fmt.Printf("\n== Go: referenced only by tests (%d) — oracles/seams or dead production code\n", len(testOnly))
	for _, l := range testOnly {
		fmt.Println(l)
	}
}

// readDirs concatenates the text of every .js/.mjs/.svelte/.ts file under dirs.
func readDirs(dirs []string) string {
	var sb strings.Builder
	for _, dir := range dirs {
		_ = filepath.WalkDir(strings.TrimSpace(dir), func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || d.Name() == "node_modules" {
				return nil
			}
			if !strings.HasSuffix(p, ".js") && !strings.HasSuffix(p, ".mjs") && !strings.HasSuffix(p, ".svelte") {
				return nil
			}
			f, oerr := os.Open(p)
			if oerr != nil {
				return nil
			}
			defer f.Close()
			sc := bufio.NewScanner(f)
			sc.Buffer(make([]byte, 1<<20), 1<<24)
			for sc.Scan() {
				sb.WriteString(sc.Text())
				sb.WriteByte('\n')
			}
			return nil
		})
	}
	return sb.String()
}
