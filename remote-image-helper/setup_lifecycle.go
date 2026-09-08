package main

// installationSteps keeps file replacement behind successful process shutdown.
type installationSteps struct {
	stop, binary, config, startup, start func() error
}

func (steps installationSteps) run() error {
	for _, step := range []func() error{steps.stop, steps.binary, steps.config, steps.startup, steps.start} {
		if err := step(); err != nil {
			return err
		}
	}
	return nil
}
