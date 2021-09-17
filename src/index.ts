import { Cond } from './cond'
import * as uuid from 'uuid'
import {
	createLongJSONFromEntry,
	createShortJSONFromEntry,
	OperationContextEntryJSON,
	OperationContextEntry,
} from './entry'

/**
 * An error created using a context.
 */
export class OperationError extends Error {
	readonly failedAt: number
	constructor(message: string, readonly context: OperationContext) {
		super(message)
		this.failedAt = Date.now()
	}
}

export enum OperationContextStatus {
	/**
	 * Represents a created but not yet ended operation.
	 */
	running = 'running',

	/**
	 * Represents an operation that has experienced at least one error.
	 */
	failed = 'failed',

	/**
	 * Represents an operation that received a cancellation signal.
	 */
	cancelled = 'cancelled',

	/**
	 * Represents an operation that received an end signal and did not
	 * experience any errors.
	 */
	ended = 'ended',
}

interface OperationContextJSON {
	readonly status: OperationContextStatus
	readonly operationID: string
	readonly trace: OperationContextEntryJSON[]
	readonly startedAt: number
	readonly endedAt?: number
}

/**
 * @class OperationContext
 *
 * Responsible for managing the overall asynchronous operation. This
 * object should not be passed after the parent that creates the operation.
 */
export class OperationContext {
	private readonly id: string

	private status: OperationContextStatus = OperationContextStatus.running
	private readonly waitCond

	private stack: OperationContextEntry[] = []
	private errors: OperationError[] = []

	private readonly startedAt: number = Date.now()
	private endedAt?: number

	private timeout?: NodeJS.Timer
	private timeoutError?: Error

	private readonly activeProcesses: PromiseLike<void>[] = []

	constructor() {
		this.id = uuid.v4()
		this.waitCond = new Cond(this.id)
		this.waitCond.lock()
	}

	/**
	 * @returns {boolean} true if the operation is currently running
	 * check this method to exit gracefully when operations are cancelled
	 */
	isRunning(): boolean {
		return this.status === OperationContextStatus.running
	}

	/**
	 * Sets the status to an ending status, and unlocks any waiters.
	 * @internal
	 */
	private setStatus(
		status:
			| OperationContextStatus.ended
			| OperationContextStatus.failed
			| OperationContextStatus.cancelled,
	): void {
		this.status = status
		this.endedAt = Date.now()
		this.waitCond.unlock()
	}

	/**
	 * Sets one or multiple values on the current context. If the keys already
	 * exist, they will be overwritten.
	 * @param values additional values to append
	 */
	setValues(values: Record<string, any>): OperationContext {
		if (this.timeoutError) {
			throw this.timeoutError
		}
		if (!this.isRunning()) {
			throw this.createError(`Cannot set values on a ${this.status} operation`)
		}
		this.stack.push({ values, error: new Error('---') })
		return this
	}

	/**
	 * Given a request, appends the key information onto the current context.
	 * @param request the http request
	 * @param response the http response
	 */
	addHttpRequest(
		request?: {
			method: string
			url: string
			headers: Record<string, string>
			body: any
		},
		response?: {
			statusCode: number
			headers: Record<string, string>
			body: any
		},
	): OperationContext {
		this.setValues({
			request: request ?? null,
			response: response ?? null,
		})
		return this
	}

	/**
	 * Sends a cancellation signal. After this is called, the context can no longer
	 * be extended via `.next()`.
	 */
	cancel(): OperationContext {
		if (!this.isRunning()) {
			throw this.createError(`Cannot cancel a ${this.status} operation`)
		}
		this.setStatus(OperationContextStatus.cancelled)
		return this
	}

	/**
	 * Sets a timeout on the context. If the context is not ended within this time,
	 * the context will be forcefully failed with a timeout error.
	 *
	 * Only one timeout may exist on a context at any given time.
	 *
	 * @param maxTime maximum time in milliseconds to wait before ending the operation
	 */
	setTimeout(maxTime: number): OperationContext {
		if (this.timeout) {
			throw this.createError(`Cannot set another timeout on the operation`)
		}

		this.timeout = setTimeout(() => {
			if (this.isRunning()) {
				this.timeoutError = this.createError(
					`Operation timed out after ${maxTime}ms`,
				)
			}
		}, maxTime)
		return this
	}

	/**
	 * Sends an end signal to the operation. After this, the operation cannot
	 * be extended using `.next()`.
	 */
	end(): OperationContext {
		if (this.timeoutError) {
			throw this.timeoutError
		}
		if (!this.isRunning()) {
			throw this.createError(`Cannot end a ${this.status} operation`)
		}
		if (this.activeProcesses.length > 0) {
			throw this.createError(
				`Cannot end an operation with background processes, please use .wait()`,
			)
		}
		if (this.timeout) {
			clearTimeout(this.timeout)
		}
		this.setStatus(OperationContextStatus.ended)
		return this
	}

	/**
	 * Fails a context, and creates a context-rich error. Once an error has been
	 * created, the context cannot be extended using `.next()`.
	 * @param message the error message
	 */
	createError(message: string): OperationError {
		if (!this.endedAt) {
			this.endedAt = Date.now()
		}
		this.setStatus(OperationContextStatus.failed)
		const err = new OperationError(message, this)
		this.errors.push(err)
		return err
	}

	/**
	 * Adds a background process to the current operation. When the given promise
	 * resolves or rejects, the operation is considered complete. The success of the current
	 * operation depends on the background process.
	 * @param promise a promise returned by the background operation
	 */
	addBackgroundProcess(promise: PromiseLike<any>): OperationContext {
		const p = promise.then(
			() => {},
			(error) => {
				this.createError(error.message || String(error))
			},
		)
		this.activeProcesses.push(p)

		return this
	}

	/**
	 * Wait for an ending signal.
	 */
	async wait() {
		if (this.activeProcesses.length > 0) {
			await Promise.race<any>([
				Promise.all(this.activeProcesses),
				this.waitCond.wait(),
			])
		} else {
			await this.waitCond.wait()
		}

		this.waitCond.unlock()
		const firstErr = this.errors[0]
		if (firstErr) {
			throw firstErr
		}
	}

	/**
	 * Returns the full list of errors received by this operation, each with its
	 * own context and failure time.
	 */
	getErrors(): OperationError[] {
		return this.errors
	}

	/**
	 * @returns json a json-serializable object representing the context currently
	 */
	toJSON(): OperationContextJSON {
		return {
			status: this.status,
			operationID: this.id,
			trace: this.stack.map((entry) => createLongJSONFromEntry(entry)),
			startedAt: this.startedAt,
			endedAt: this.endedAt,
		}
	}

	/**
	 * @returns json a shortened version of the `toJSON()` response (all empty entries are
	 * filtered out, and only a single stacktrace item is included)
	 */
	toShortJSON(): OperationContextJSON {
		return {
			status: this.status,
			operationID: this.id,
			trace: this.stack.map((entry) => createShortJSONFromEntry(entry)),
			startedAt: this.startedAt,
			endedAt: this.endedAt,
		}
	}
}
