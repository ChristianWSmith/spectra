package mappack

import "strings"

// The render-geometry policy. The world used for sight lines is the map's render
// geometry (the textured world the player sees), minus two kinds of geometry.
//
// Dynamic entities are left out. Doors, breakables, moving brushes and physics
// props are placed in one state, but a kill can happen with them in another
// (doors open, crates broken, brushes moved). With them in, lines the server
// recorded as kills were blocked. Excluding them is the conservative choice: it
// makes sight lines more permissive, and the random-pair control shows the cost.
//
// See-through materials are left out: particle cards, steam and light shafts,
// puddle planes, and glass. They do not stop a player seeing through them.
// Borderline materials stay in; they are listed in FOLLOWUP.md.
var renderExcludedClasses = map[string]bool{
	"prop_door_rotating":       true,
	"func_door":                true,
	"func_door_rotating":       true,
	"func_movelinear":          true,
	"func_rotating":            true,
	"func_brush":               true,
	"func_breakable":           true,
	"func_breakable_surf":      true,
	"prop_dynamic":             true,
	"prop_dynamic_override":    true,
	"prop_physics":             true,
	"prop_physics_multiplayer": true,
	"prop_physics_override":    true,
}

// renderSkipMaterials are name fragments of materials left out of the render geometry.
var renderSkipMaterials = []string{"effects/smoke", "effects/steam", "lightshaft", "puddle", "glass"}

// skipMaterial reports whether a material is left out of the render geometry.
func skipMaterial(name string) bool {
	low := strings.ToLower(name)
	for _, s := range renderSkipMaterials {
		if strings.Contains(low, s) {
			return true
		}
	}
	return false
}
