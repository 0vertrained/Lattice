//! Reproducible synthetic planning cases; never dispatches or simulates motion.
use lattice_domain::{
    BodyId, Capability,
    navigation::{
        RouteCandidate, RouteFailureCode, RoutePlan, RoutePlanningFailure, RoutePose, RouteRequest,
        RouteSegment, SemanticMap, SemanticPlace, plan_route,
    },
};
use serde::Serialize;
use serde_json::json;
use std::{hint::black_box, time::Instant};

type Error = Box<dyn std::error::Error>;
type Fixture = (SemanticMap, RouteRequest, Vec<RouteCandidate>);

#[derive(Clone, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
enum Expected {
    Plan {
        segment_body_pairs: Vec<(String, String)>,
        transfers: usize,
        destination_body: String,
    },
    Refusal {
        code: RouteFailureCode,
    },
}
impl Expected {
    fn matches(&self, result: &Result<RoutePlan, RoutePlanningFailure>) -> bool {
        match (self, result) {
            (Self::Refusal { code }, Err(failure)) => *code == failure.code,
            (
                Self::Plan {
                    segment_body_pairs,
                    transfers,
                    destination_body,
                },
                Ok(plan),
            ) => {
                plan.legs
                    .iter()
                    .map(|leg| (leg.segment_id.clone(), leg.body_id.to_string()))
                    .collect::<Vec<_>>()
                    == *segment_body_pairs
                    && plan.transfers.len() == *transfers
                    && plan.destination_body_id.as_str() == destination_body
            }
            _ => false,
        }
    }
}
struct Scenario {
    id: &'static str,
    fixture: Fixture,
    expected: Expected,
}
fn staged(id: &str, place: &str, capabilities: &[Capability]) -> Result<RouteCandidate, Error> {
    Ok(RouteCandidate {
        body_id: BodyId::new(id)?,
        place_id: Some(place.into()),
        capabilities: capabilities.iter().copied().collect(),
        ready: true,
        available: true,
    })
}
fn fixture() -> Result<Fixture, Error> {
    Ok((
        serde_json::from_str(include_str!(
            "../../../simulation/routes/warehouse-stairs.json"
        ))?,
        RouteRequest {
            source_body_id: BodyId::new("rover-a")?,
            source_place_id: "inspection_bay".into(),
            destination_place_id: "upper_inspection".into(),
            destination_capability: Some(Capability::Inspect),
        },
        vec![
            staged(
                "rover-a",
                "inspection_bay",
                &[Capability::Navigate, Capability::Inspect],
            )?,
            staged(
                "quad-b",
                "stair_transfer",
                &[
                    Capability::Navigate,
                    Capability::Stairs,
                    Capability::Inspect,
                ],
            )?,
        ],
    ))
}
fn planned(pairs: &[(&str, &str)], transfers: usize, destination: &str) -> Expected {
    Expected::Plan {
        segment_body_pairs: pairs
            .iter()
            .map(|(segment, body)| ((*segment).into(), (*body).into()))
            .collect(),
        transfers,
        destination_body: destination.into(),
    }
}
fn scenarios() -> Result<Vec<Scenario>, Error> {
    let baseline = fixture()?;
    let stairs = planned(
        &[
            ("bay_to_transfer", "rover-a"),
            ("stairs_to_upper", "quad-b"),
        ],
        1,
        "quad-b",
    );
    let mut scenarios = vec![Scenario {
        id: "staged_stair_transfer",
        fixture: baseline.clone(),
        expected: stairs.clone(),
    }];
    let mut add = |id, expected, change: fn(&mut Fixture)| {
        let mut fixture = baseline.clone();
        change(&mut fixture);
        scenarios.push(Scenario {
            id,
            fixture,
            expected,
        });
    };
    add(
        "same_body_flat_route",
        planned(&[("bay_to_transfer", "rover-a")], 0, "rover-a"),
        |(_, request, _)| {
            request.destination_place_id = "stair_transfer".into();
        },
    );
    add(
        "target_unavailable",
        Expected::Refusal {
            code: RouteFailureCode::NoCapableBody,
        },
        |(_, _, bodies)| bodies[1].available = false,
    );
    add(
        "target_unready",
        Expected::Refusal {
            code: RouteFailureCode::NoCapableBody,
        },
        |(_, _, bodies)| bodies[1].ready = false,
    );
    add(
        "target_missing_stairs",
        Expected::Refusal {
            code: RouteFailureCode::NoCapableBody,
        },
        |(_, _, bodies)| {
            bodies[1].capabilities.remove(&Capability::Stairs);
        },
    );
    add(
        "no_destination_inspection_capability",
        Expected::Refusal {
            code: RouteFailureCode::NoCapableBody,
        },
        |(_, _, bodies)| {
            for body in bodies {
                body.capabilities.remove(&Capability::Inspect);
            }
        },
    );
    add(
        "target_unknown_placement",
        Expected::Refusal {
            code: RouteFailureCode::NoCapableBody,
        },
        |(_, _, bodies)| bodies[1].place_id = None,
    );
    add(
        "target_wrong_staging_place",
        Expected::Refusal {
            code: RouteFailureCode::TransferUnavailable,
        },
        |(_, _, bodies)| bodies[1].place_id = Some("inspection_bay".into()),
    );
    add(
        "transfer_disallowed",
        Expected::Refusal {
            code: RouteFailureCode::TransferUnavailable,
        },
        |(map, _, _)| map.places[1].transfer_allowed = false,
    );
    add(
        "stair_segment_disabled",
        Expected::Refusal {
            code: RouteFailureCode::BlockedRoute,
        },
        |(map, _, _)| map.segments[1].enabled = false,
    );
    add(
        "destination_disconnected",
        Expected::Refusal {
            code: RouteFailureCode::Unreachable,
        },
        |(map, _, _)| {
            map.segments.pop();
        },
    );
    add(
        "source_wrong_place",
        Expected::Refusal {
            code: RouteFailureCode::SourceUnavailable,
        },
        |(_, _, bodies)| bodies[0].place_id = Some("stair_transfer".into()),
    );
    add(
        "source_unavailable",
        Expected::Refusal {
            code: RouteFailureCode::SourceUnavailable,
        },
        |(_, _, bodies)| bodies[0].available = false,
    );
    add(
        "cycle_preserves_shortest_route",
        stairs.clone(),
        |(map, _, _)| {
            map.segments.push(RouteSegment {
                id: "return_loop".into(),
                from: "stair_transfer".into(),
                to: "inspection_bay".into(),
                required_capabilities: [Capability::Navigate].into_iter().collect(),
                max_speed_mps: 0.2,
                enabled: true,
            });
        },
    );
    add(
        "reordered_input_preserves_assignments",
        stairs.clone(),
        |(map, _, bodies)| {
            map.places.reverse();
            map.segments.reverse();
            bodies.reverse();
        },
    );
    add(
        "invalid_mobility_requirement",
        Expected::Refusal {
            code: RouteFailureCode::InvalidInput,
        },
        |(map, _, _)| {
            map.segments[1].required_capabilities = [Capability::Stairs].into_iter().collect();
        },
    );
    add(
        "thirteen_legs_exceeds_bound",
        Expected::Refusal {
            code: RouteFailureCode::SearchLimit,
        },
        |(map, request, bodies)| {
            map.places = (0..14)
                .map(|i| SemanticPlace {
                    id: format!("place_{i}"),
                    label: format!("Place {i}"),
                    pose: RoutePose {
                        x: f64::from(i),
                        y: 0.0,
                        z: 0.0,
                    },
                    arrival_radius_m: 0.25,
                    transfer_allowed: false,
                })
                .collect();
            map.segments = (0..13)
                .map(|i| RouteSegment {
                    id: format!("segment_{i}"),
                    from: format!("place_{i}"),
                    to: format!("place_{}", i + 1),
                    required_capabilities: [Capability::Navigate].into_iter().collect(),
                    max_speed_mps: 0.2,
                    enabled: true,
                })
                .collect();
            request.source_place_id = "place_0".into();
            request.destination_place_id = "place_13".into();
            bodies.truncate(1);
            bodies[0].place_id = Some("place_0".into());
        },
    );
    let mut terminal = baseline.clone();
    terminal.0.places[2].transfer_allowed = true;
    terminal.2[1].capabilities.remove(&Capability::Inspect);
    terminal.2.push(staged(
        "camera-c",
        "upper_inspection",
        &[Capability::Inspect],
    )?);
    scenarios.push(Scenario {
        id: "destination_inspection_transfer",
        fixture: terminal,
        expected: planned(
            &[
                ("bay_to_transfer", "rover-a"),
                ("stairs_to_upper", "quad-b"),
            ],
            2,
            "camera-c",
        ),
    });
    let mut colocated = baseline.clone();
    colocated.1.source_place_id = "stair_transfer".into();
    colocated.1.destination_place_id = "stair_transfer".into();
    colocated.2 = vec![
        staged("rover-a", "stair_transfer", &[Capability::Navigate])?,
        staged("camera-c", "stair_transfer", &[Capability::Inspect])?,
    ];
    scenarios.push(Scenario {
        id: "colocated_zero_leg_inspection_transfer",
        fixture: colocated,
        expected: planned(&[], 1, "camera-c"),
    });
    let mut tie = baseline;
    tie.2.push(staged(
        "quad-c",
        "stair_transfer",
        &[
            Capability::Navigate,
            Capability::Stairs,
            Capability::Inspect,
        ],
    )?);
    scenarios.push(Scenario {
        id: "equal_cost_lexical_body_choice",
        fixture: tie,
        expected: stairs,
    });
    Ok(scenarios)
}
fn main() -> Result<(), Error> {
    const SAMPLES: usize = 100;
    let mut cases = Vec::new();
    let mut all_match = true;
    for scenario in scenarios()? {
        let (map, request, bodies) = &scenario.fixture;
        let outcome = plan_route(map, request, bodies);
        let mut repeatable = true;
        for _ in 0..5 {
            let _ = black_box(plan_route(map, request, bodies));
        }
        let mut durations_ns = Vec::with_capacity(SAMPLES);
        for _ in 0..SAMPLES {
            let started = Instant::now();
            let actual = black_box(plan_route(
                black_box(map),
                black_box(request),
                black_box(bodies),
            ));
            durations_ns.push(started.elapsed().as_nanos());
            repeatable &= actual == outcome;
        }
        durations_ns.sort_unstable();
        let matches_expected = scenario.expected.matches(&outcome);
        all_match &= matches_expected && repeatable;
        cases.push(json!({
            "scenario": scenario.id, "input": {"map": map, "request": request, "candidates": bodies},
            "expected": scenario.expected, "observed": outcome,
            "matches_expected": matches_expected, "repeatable": repeatable,
            "planning_time_ns": {"samples": SAMPLES, "warmup_calls": 5,
                "min": durations_ns[0], "median": (durations_ns[SAMPLES / 2 - 1] + durations_ns[SAMPLES / 2]) / 2,
                "p95": durations_ns[(SAMPLES * 95).div_ceil(100) - 1], "max": durations_ns[SAMPLES - 1]}
        }));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "schema_version": 1, "evaluation": "deterministic_semantic_route_planner",
            "recorded_at": chrono::Utc::now().to_rfc3339(),
            "scope": "Synthetic pure-planner fixtures. No dispatch, controller, localization, perception, transport or physical traversal is evaluated. Expected refusals are recorded as refusals, not completed missions.",
            "timing_method": "100 sequential calls after 5 warmups per fixed scenario; Instant wall time includes validation, search, explanations and successful map hashing; excludes serialization, compilation and I/O; nearest-rank p95. No latency acceptance threshold.",
            "runtime": {"architecture": std::env::consts::ARCH, "os": std::env::consts::OS, "debug_assertions": cfg!(debug_assertions)},
            "all_match_expected": all_match, "scenarios": cases
        }))?
    );
    if !all_match {
        return Err(
            "planner evaluation differs from expected outcomes or is not deterministic".into(),
        );
    }
    Ok(())
}
