//! Exports canonical Rust route snapshots for cross-language local adapters.
use lattice_domain::{RouteTraversal, navigation::SemanticMap};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("pass a trusted semantic map path")?;
    let map: SemanticMap = serde_json::from_slice(&std::fs::read(path)?)?;
    map.validate()?;
    let traversals = map
        .segments
        .iter()
        .filter(|segment| segment.enabled)
        .map(|segment| RouteTraversal::from_segment(&map, segment))
        .collect::<Result<Vec<_>, _>>()?;
    println!(
        "{}",
        serde_json::to_string_pretty(
            &serde_json::json!({"map_digest":map.digest()?,"traversals":traversals})
        )?
    );
    Ok(())
}
