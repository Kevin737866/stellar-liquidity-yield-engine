// Compile the real router without adding its unfinished execution API to the
// deployable contract feature set.
#![allow(dead_code, clippy::too_many_arguments)]

macro_rules! require {
    ($cond:expr, $err:expr) => {
        if !$cond {
            panic!("{:?}", $err)
        }
    };
}

#[path = "../src/swap_router.rs"]
mod swap_router;
