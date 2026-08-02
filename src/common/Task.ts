export class Task {
	taskName!: string;
	func!: (...args: unknown[]) => unknown;
}
