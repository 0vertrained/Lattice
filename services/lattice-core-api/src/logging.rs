//! JSON log lines that Cloud Logging files at their real severity.
//!
//! Cloud Logging reads a JSON line's `severity` field and does not know tracing's `level`, so
//! without it every line, errors included, is filed as Default and a severity filter hides it.
use std::io::Write;

use tracing::{Level, Metadata};
use tracing_subscriber::fmt::MakeWriter;

/// Writes each formatted event to standard output with a `severity` field added.
pub struct WithSeverity;

impl<'a> MakeWriter<'a> for WithSeverity {
    type Writer = SeverityWriter;

    fn make_writer(&'a self) -> Self::Writer {
        SeverityWriter {
            severity: "DEFAULT",
            tagged: false,
        }
    }

    fn make_writer_for(&'a self, meta: &Metadata<'_>) -> Self::Writer {
        SeverityWriter {
            severity: severity(*meta.level()),
            tagged: false,
        }
    }
}

pub struct SeverityWriter {
    severity: &'static str,
    tagged: bool,
}

impl Write for SeverityWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        // The formatter hands over each event as one complete line, so only its start is tagged.
        let line = if std::mem::replace(&mut self.tagged, true) {
            buf.to_vec()
        } else {
            tag(buf, self.severity)
        };
        std::io::stdout().lock().write_all(&line)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        std::io::stdout().flush()
    }
}

fn severity(level: Level) -> &'static str {
    match level {
        Level::ERROR => "ERROR",
        Level::WARN => "WARNING",
        Level::INFO => "INFO",
        _ => "DEBUG",
    }
}

fn tag(line: &[u8], severity: &str) -> Vec<u8> {
    let Some((&b'{', rest)) = line.split_first() else {
        return line.to_vec();
    };
    let mut tagged = Vec::with_capacity(line.len() + 24);
    tagged.extend_from_slice(b"{\"severity\":\"");
    tagged.extend_from_slice(severity.as_bytes());
    tagged.push(b'"');
    if rest.first() != Some(&b'}') {
        tagged.push(b',');
    }
    tagged.extend_from_slice(rest);
    tagged
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn adds_cloud_logging_severity_and_keeps_the_line() {
        let line = br#"{"timestamp":"2026-11-03T23:29:30Z","level":"ERROR","fields":{"message":"Lattice Core stopped"}}
"#;
        let tagged = tag(line, severity(Level::ERROR));
        assert!(tagged.ends_with(b"\n"));
        let entry: serde_json::Value = serde_json::from_slice(&tagged).unwrap();
        assert_eq!(entry["severity"], "ERROR");
        assert_eq!(entry["level"], "ERROR");
        assert_eq!(entry["fields"]["message"], "Lattice Core stopped");
        assert_eq!(tag(b"{}", "INFO"), br#"{"severity":"INFO"}"#);
        assert_eq!(tag(b"not json\n", "INFO"), b"not json\n");
    }

    #[test]
    fn maps_every_level_to_a_cloud_logging_severity() {
        assert_eq!(severity(Level::WARN), "WARNING");
        assert_eq!(severity(Level::INFO), "INFO");
        assert_eq!(severity(Level::TRACE), "DEBUG");
    }
}
