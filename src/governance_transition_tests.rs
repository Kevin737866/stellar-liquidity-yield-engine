#![cfg(test)]

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProposalState {
    Pending,
    Active,
    Canceled,
    Defeated,
    Succeeded,
    Queued,
    Expired,
    Executed,
}

const TIMELOCK_DELAY: u64 = 2 * 24 * 60 * 60;
const QUEUED_EXPIRY_DELAY: u64 = 7 * 24 * 60 * 60;

fn advance_state(
    state: ProposalState,
    now: u64,
    start_time: u64,
    end_time: u64,
    eta: u64,
    passed: bool,
) -> ProposalState {
    match state {
        ProposalState::Pending if now >= start_time => ProposalState::Active,
        ProposalState::Active if now >= end_time => {
            if passed {
                ProposalState::Succeeded
            } else {
                ProposalState::Defeated
            }
        }
        ProposalState::Queued
            if eta
                .checked_add(QUEUED_EXPIRY_DELAY)
                .map_or(false, |expires_at| now >= expires_at) =>
        {
            ProposalState::Expired
        }
        _ => state,
    }
}

fn is_voting_open(state: ProposalState, now: u64, start_time: u64, end_time: u64) -> bool {
    state == ProposalState::Active && now >= start_time && now < end_time
}

fn queue_eta(queue_time: u64) -> Option<u64> {
    queue_time.checked_add(TIMELOCK_DELAY)
}

fn can_execute(state: ProposalState, now: u64, eta: u64) -> bool {
    state == ProposalState::Queued && now >= eta
}

fn can_cancel(state: ProposalState) -> bool {
    state == ProposalState::Pending || state == ProposalState::Active
}

#[test]
fn proposal_becomes_active_at_its_start_time() {
    let start_time = 1_000;

    assert_eq!(
        advance_state(
            ProposalState::Pending,
            start_time - 1,
            start_time,
            2_000,
            0,
            false
        ),
        ProposalState::Pending
    );
    assert_eq!(
        advance_state(
            ProposalState::Pending,
            start_time,
            start_time,
            2_000,
            0,
            false
        ),
        ProposalState::Active
    );
    assert_eq!(
        advance_state(
            ProposalState::Pending,
            start_time + 1,
            start_time,
            2_000,
            0,
            false
        ),
        ProposalState::Active
    );
}

#[test]
fn voting_window_includes_start_but_excludes_end() {
    let start_time = 1_000;
    let end_time = 2_000;

    assert!(!is_voting_open(
        ProposalState::Pending,
        start_time,
        start_time,
        end_time
    ));
    assert!(!is_voting_open(
        ProposalState::Active,
        start_time - 1,
        start_time,
        end_time
    ));
    assert!(is_voting_open(
        ProposalState::Active,
        start_time,
        start_time,
        end_time
    ));
    assert!(is_voting_open(
        ProposalState::Active,
        end_time - 1,
        start_time,
        end_time
    ));
    assert!(!is_voting_open(
        ProposalState::Active,
        end_time,
        start_time,
        end_time
    ));
}

#[test]
fn active_proposal_resolves_at_end_time_using_vote_outcome() {
    let end_time = 2_000;

    assert_eq!(
        advance_state(
            ProposalState::Active,
            end_time - 1,
            1_000,
            end_time,
            0,
            true
        ),
        ProposalState::Active
    );
    assert_eq!(
        advance_state(ProposalState::Active, end_time, 1_000, end_time, 0, true),
        ProposalState::Succeeded
    );
    assert_eq!(
        advance_state(ProposalState::Active, end_time, 1_000, end_time, 0, false),
        ProposalState::Defeated
    );
}

#[test]
fn timelock_allows_execution_at_eta_but_not_before() {
    let queue_time = 1_000_000;
    let eta = queue_eta(queue_time).unwrap();

    assert_eq!(eta, queue_time + TIMELOCK_DELAY);
    assert!(!can_execute(ProposalState::Queued, eta - 1, eta));
    assert!(can_execute(ProposalState::Queued, eta, eta));
    assert!(can_execute(ProposalState::Queued, eta + 1, eta));
    assert!(!can_execute(ProposalState::Succeeded, eta, eta));
    assert!(!can_execute(ProposalState::Executed, eta, eta));
}

#[test]
fn queued_proposal_expires_at_the_seven_day_deadline() {
    let eta = 5_000;
    let expires_at = eta + QUEUED_EXPIRY_DELAY;

    assert_eq!(
        advance_state(ProposalState::Queued, expires_at - 1, 0, 0, eta, false),
        ProposalState::Queued
    );
    assert_eq!(
        advance_state(ProposalState::Queued, expires_at, 0, 0, eta, false),
        ProposalState::Expired
    );
    assert_eq!(
        advance_state(ProposalState::Queued, expires_at + 1, 0, 0, eta, false),
        ProposalState::Expired
    );
}

#[test]
fn time_updates_do_not_change_terminal_states_or_allow_invalid_cancellation() {
    for state in [
        ProposalState::Canceled,
        ProposalState::Defeated,
        ProposalState::Succeeded,
        ProposalState::Expired,
        ProposalState::Executed,
    ] {
        assert_eq!(advance_state(state, u64::MAX, 0, 0, 0, true), state);
        assert!(!can_cancel(state));
    }
    assert!(can_cancel(ProposalState::Pending));
    assert!(can_cancel(ProposalState::Active));
}

#[test]
fn timelock_eta_overflow_is_reported_instead_of_wrapping() {
    assert_eq!(queue_eta(u64::MAX), None);
}
