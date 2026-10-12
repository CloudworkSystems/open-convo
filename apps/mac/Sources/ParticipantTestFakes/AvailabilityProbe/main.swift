import Foundation
import ParticipantProcess

// A test-target probe, never bundled: prints the shipping availability answer
// as one line, `available=<bool> reason=<reason or none>`. A test runs it as
// its own process with invented environment variables, launch arguments
// (including `-Name value` defaults), and invented flag files in its working
// folder, HOME and TMPDIR, to check that none of them changes the answer.

let done = DispatchSemaphore(value: 0)
Task.detached {
    let answer = await ShippingAvailability().check()
    print("available=\(answer.available) reason=\(answer.reason?.rawValue ?? "none")")
    done.signal()
}
done.wait()
