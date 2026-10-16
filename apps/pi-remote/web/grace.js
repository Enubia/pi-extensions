export function createGrace(ms, onEnd, onReturn, timers = { set: setTimeout, clear: clearTimeout }) {
	let timer = null;
	return {
		update(present) {
			if (present) {
				if (timer === null) return;
				timers.clear(timer);
				timer = null;
				onReturn();
				return;
			}
			if (timer !== null) return;
			timer = timers.set(() => {
				timer = null;
				onEnd();
			}, ms);
		},
		cancel() {
			if (timer === null) return;
			timers.clear(timer);
			timer = null;
		},
	};
}
