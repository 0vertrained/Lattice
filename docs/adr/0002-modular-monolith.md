# ADR 0002: Start as a modular monolith

Status: Accepted

## Decision

Deploy the trusted core as one Rust process with domain, application, and
infrastructure boundaries.

## Rationale

Immediate microservices would add network failure, distributed transactions,
deployment overhead, and observability burden before workload or team ownership
requires them.

## Extraction rule

A module becomes a service only when at least one is true:

- independent scaling is measured and necessary
- a stronger security boundary is required
- a separate team owns its release lifecycle
- a different availability objective is required
