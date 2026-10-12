import Darwin
import ParticipantSupervisorCore

// The shipping supervisor: no hooks. See `supervisorMain` and contract section 11.
exit(supervisorMain(arguments: CommandLine.arguments))
