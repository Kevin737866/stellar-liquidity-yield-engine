use std::fs;
use std::path::{Path, PathBuf};

fn repository_file(relative_path: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(relative_path)
}

fn read_repository_file(relative_path: &str) -> String {
    fs::read_to_string(repository_file(relative_path))
        .unwrap_or_else(|error| panic!("failed to read {relative_path}: {error}"))
}

fn assert_contains_all(document: &str, required_text: &[&str], document_name: &str) {
    for text in required_text {
        assert!(
            document.contains(text),
            "{document_name} is missing required contract-change text: {text}"
        );
    }
}

#[test]
fn contract_change_checklist_is_linked_and_complete() {
    let contributing = read_repository_file("CONTRIBUTING.md");
    let checklist = read_repository_file("docs/CONTRACT_CHANGE_CHECKLIST.md");
    let pull_request_template = read_repository_file(".github/PULL_REQUEST_TEMPLATE.md");

    assert_contains_all(
        &contributing,
        &[
            "Contract Change Checklist",
            "docs/CONTRACT_CHANGE_CHECKLIST.md",
            "Boundary",
            "Failure",
        ],
        "CONTRIBUTING.md",
    );

    assert_contains_all(
        &checklist,
        &[
            "**Normal:**",
            "**Boundary:**",
            "**Failure:**",
            "Storage compatibility",
            "cargo build --target wasm32-unknown-unknown",
            "docs/SECURITY_CHECKLIST.md",
        ],
        "docs/CONTRACT_CHANGE_CHECKLIST.md",
    );

    assert_contains_all(
        &pull_request_template,
        &[
            "[contract change checklist]",
            "Storage compatibility",
            "Affected contracts build successfully",
        ],
        ".github/PULL_REQUEST_TEMPLATE.md",
    );
}
