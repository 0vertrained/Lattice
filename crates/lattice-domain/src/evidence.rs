//! Bounded camera evidence attached to an inspection result.
use serde::{Deserialize, Serialize};

/// A detected region in a 320x240 camera frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Detection {
    /// Supported marker class.
    pub label: String,
    /// Classifier score calibrated on synthetic crops only.
    pub confidence: f64,
    /// Pixel x, y, width and height.
    pub r#box: [u32; 4],
}

/// Image and inference provenance. The raw camera hash and annotated JPEG hash
/// refer to different artifacts; neither proves the scene is physically real.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InspectionEvidence {
    /// Versioned detector identity.
    pub model_id: String,
    /// Host receipt time of the captured ROS frame.
    pub captured_at_ms: i64,
    /// Hash of the original PPM camera frame retained in the run directory.
    pub frame_sha256: String,
    /// Hash of the annotated JPEG bytes.
    pub image_sha256: String,
    /// Bounded JPEG payload; served only through authenticated mission reads.
    pub image_base64: String,
    /// Detected regions, possibly empty on failed inspections.
    pub detections: Vec<Detection>,
    /// Explicit scope of confidence calibration.
    pub confidence_domain: String,
}
