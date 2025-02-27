import { assertMessageEvent,
    ControllerTaskRunMessage,
    ControllerMessageType,
    ControllerTerminateMessage,
    WorkerInitMessage,
    TaskUID, 
    WorkerMessageType} from "../../shared/Messages.js";
import { Terminable, WorkerModule } from "../../shared/Worker.js";
import { isTransferDescriptor, TransferDescriptor } from "../../shared/TransferDescriptor.js";
import { assert, getRandomUID, withTimeout } from "../../shared/Utils.js";
import { EsTaskPromise } from "./EsTask.js";

type StripTransfer<Type> =
    Type extends TransferDescriptor<infer BaseType>
    ? BaseType
    : Type

type ProxyFunction<Args extends any[], ReturnType> =
    (...args: Args) => Promise<StripTransfer<Awaited<ReturnType>>>

type ProxyModule<ApiType extends WorkerModule> = {
    [method in keyof ApiType]: ProxyFunction<Parameters<ApiType[method]>, ReturnType<ApiType[method]>>
}

/** Options for threads. */
export interface EsThreadOptions {
    /**
     * If the thread doesn't send the init message within timeout, it rejects.
     * 
     * In milliseconds.
     * 
     * @defaultValue 10000ms
     */
    timeout: number;
}

const DefaultEsThreadOptions: EsThreadOptions = {
    timeout: 10000
}

/**
 * EsThreads
 * 
 * Some worker errors (unhandled rejection, uncaught exceptions, posting of incorrect results/errors) are dispatched
 * by threads. You can use `thread.addEventListener("error", ...)` to recive those, but they're not particularily
 * useful, aside from maybe debugging and testing.
 * 
 * Also, for SharedWorker threads: unhandled rejection and uncaught exceptions will not be delivered until a client
 * connects. They are delivered only to the last connected client.
 * 
 * @example
 * ```ts
 * const thread = await EsThread.Spawn<HelloWorldApiType>(
 *     new Worker(new URL("threads/valid/hello-world.worker.ts", import.meta.url),
 *     {type: "module"}));
 * ```
 */
export class EsThread<ApiType extends WorkerModule> extends EventTarget implements Terminable {
    /** The threads UID. */
    readonly threadUID = getRandomUID();
    readonly options: Readonly<EsThreadOptions>;
    private readonly tasks: Map<TaskUID, EsTaskPromise<any>> = new Map();

    private readonly worker: AbstractWorker;
    private readonly interface: Worker | MessagePort;

    /** Access the thread API. */
    public methods: ProxyModule<ApiType> = {} as ProxyModule<ApiType>;

    /** The number of active (unsettled) tasks. */
    public get numQueuedTasks() { return this.tasks.size; }

    private constructor(worker: AbstractWorker, threadOptions: Partial<EsThreadOptions>) {
        super();
        this.options = { ...DefaultEsThreadOptions, ...threadOptions };

        if(typeof ServiceWorker !== "undefined" && worker instanceof ServiceWorker) {
            /* c8 ignore next 3 */
            // reason: difficult to test
            throw new Error("ServiceWorker currently not supported.");
        }

        this.worker = worker;
        if(worker instanceof Worker) this.interface = worker;
        else {
            assert(worker instanceof SharedWorker);
            this.interface = worker.port;
            worker.port.start();
        }
    }

    /**
     * Spawn a new thread.
     * @param worker - The worker for this thread.
     * @param threadOptions - Thread options.
     * @returns A new thread.
     */
    public static async Spawn<ApiType extends WorkerModule>(worker: AbstractWorker, threadOptions: Partial<EsThreadOptions> = {}) {
        const thread = new EsThread<ApiType>(worker, threadOptions);
        return thread.initThread();
    }

    /** Returns a promise that resolves when all tasks are settled. */
    public async settled(): Promise<void> {
        await Promise.allSettled(this.tasks.values());
    }

    /**
     * Returns a promise that resolves when all tasks are resolved
     * and rejects when any task rejects.
     */
    public async resolved(): Promise<void> {
        await Promise.all(this.tasks.values());
    }

    /**
     * Terminate this thread.
     * 
     * Waits for all tasks to settle. If tasks resolving is required, call
     * {@link EsThread#resolved} before calling {@link EsThread#terminate}.
     * 
     * @param forceTerminateShared - If you want to make sure SharedWorkers abort.
     * Probably not a great idea, but one might want to do it.
     */
    public async terminate(forceTerminateShared?: boolean): Promise<void> {
        // Don't terminate until all tasks are done.
        await this.settled();

        // Send terminate message to worker.
        const terminateMessage: ControllerTerminateMessage = {
            type: ControllerMessageType.Terminate,
            forceTerminateShared: forceTerminateShared };
        this.interface.postMessage(terminateMessage, []);

        this.interface.removeEventListener("message", this.taskResultDispatch);

        if(this.worker instanceof Worker) this.worker.terminate();
        else {
            assert(this.worker instanceof SharedWorker);
            this.worker.port.close();
        }
    }

    private taskResultDispatch = (evt: Event) => {
        try {
            assertMessageEvent(evt);
            // TODO: assertWorkerMessage(evt.data);

            switch(evt.data.type) {
                case WorkerMessageType.TaskResult: {
                        const task = this.tasks.get(evt.data.uid);
                        if(!task) throw new Error("Recived result for invalid task with UID " + evt.data.uid);
                        this.tasks.delete(task.taskUID);
                        task.resolve(evt.data.result);
                    }
                    break;

                case WorkerMessageType.TaskError: {
                        const task = this.tasks.get(evt.data.uid);
                        if(!task) throw new Error("Recived error for invalid task with UID " + evt.data.uid);
                        this.tasks.delete(task.taskUID);
                        task.reject(new Error(evt.data.errorMessage));
                    }
                    break;

                case WorkerMessageType.UnchaughtError:
                    throw new Error("Uncaught error in worker: " + evt.data.errorMessage);

                default:
                    throw new Error("Recieved unexpected WorkerMessage of type: " + evt.data.type);
            }
        }
        catch(e) {
            this.dispatchEvent(new ErrorEvent("error", {error: e}));
        }
    }

    private static prepareArguments(rawArgs: any[]): {args: any[], transferables: Transferable[]} {
        const args: any[] = [];
        const transferables: Transferable[] = [];
        for(const arg of rawArgs) {
            if(isTransferDescriptor(arg)) {
                transferables.push(...arg.transferables)
                args.push(arg);
            }
            else {
                args.push(arg);
            }
        }
    
        return {args: args, transferables: transferables}
    }

    private createProxyFunction<Args extends any[], ReturnType>(method: string) {
        return ((...rawArgs: Args): Promise<ReturnType> => {
            const taskPromise = new EsTaskPromise<ReturnType>();
            const { args, transferables } = EsThread.prepareArguments(rawArgs);
            const runMessage: ControllerTaskRunMessage = {
                type: ControllerMessageType.Run,
                uid: taskPromise.taskUID,
                method: method,
                args: args };

            this.tasks.set(taskPromise.taskUID, taskPromise);
            this.interface.postMessage(runMessage, transferables);

            return taskPromise;
        }) as ProxyFunction<Args, ReturnType>;
    }

    private createMethodsProxy(
        methodNames: string[])
    {
        const proxy = this.methods as any;
    
        for (const methodName of methodNames) {
            proxy[methodName] = this.createProxyFunction(methodName);
        }
    }

    private async initThread() {
        let exposedApi;
        try {
            exposedApi = await withTimeout(new Promise<WorkerInitMessage>((resolve, reject) => {
                const initMessageHandler = (event: Event) => {
                    assertMessageEvent(event);
                    // TODO: assertWorkerMessage(evt.data);

                    switch(event.data.type) {
                        case WorkerMessageType.Init:
                            this.interface.removeEventListener("message", initMessageHandler);
                            resolve(event.data);
                            break;

                        case WorkerMessageType.UnchaughtError:
                            this.interface.removeEventListener("message", initMessageHandler);
                            reject(new Error(event.data.errorMessage));
                            break;

                        default:
                            this.interface.removeEventListener("message", initMessageHandler);
                            reject(new Error("Recieved unexpected WorkerMessage of type: " + event.data.type));
                    }
                };
                this.interface.addEventListener("message", initMessageHandler)
            }), this.options.timeout, `Timeout: Did not receive an init message from worker after ${this.options.timeout}ms`);
        }
        catch(e) {
            // If init times out, terminate worker, or close the message port.
            if(this.worker instanceof Worker) this.worker.terminate();
            else {
                assert(this.worker instanceof SharedWorker)
                this.worker.port.close();
            }
            throw e;
        }

        this.createMethodsProxy(exposedApi.methodNames);

        this.interface.addEventListener("message", this.taskResultDispatch);

        return this;
    }
}