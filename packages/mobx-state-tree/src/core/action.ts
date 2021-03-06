import { action as mobxAction } from "mobx"
import {
    getStateTreeNode,
    IStateTreeNode,
    fail,
    argsToArray,
    IDisposer,
    getRoot,
    EMPTY_ARRAY,
    ObjectNode,
    HookNames
} from "../internal"

export type IMiddlewareEventType =
    | "action"
    | "flow_spawn"
    | "flow_resume"
    | "flow_resume_error"
    | "flow_return"
    | "flow_throw"
// | "task_spawn TODO, see #273"

export type IMiddlewareEvent = {
    type: IMiddlewareEventType
    name: string
    id: number
    parentId: number
    rootId: number
    context: IStateTreeNode
    tree: IStateTreeNode
    args: any[]
}

export type IMiddleware = {
    handler: IMiddlewareHandler
    includeHooks: boolean
}
export type IMiddlewareHandler = (
    actionCall: IMiddlewareEvent,
    next: (actionCall: IMiddlewareEvent) => any
) => any

let nextActionId = 1
let currentActionContext: IMiddlewareEvent | null = null

export function getNextActionId() {
    return nextActionId++
}

export function runWithActionContext(context: IMiddlewareEvent, fn: Function) {
    const node = getStateTreeNode(context.context)
    const baseIsRunningAction = node._isRunningAction
    const prevContext = currentActionContext
    node.assertAlive()
    node._isRunningAction = true
    currentActionContext = context
    try {
        return runMiddleWares(node, context, fn)
    } finally {
        currentActionContext = prevContext
        node._isRunningAction = baseIsRunningAction
    }
}

export function getActionContext(): IMiddlewareEvent {
    if (!currentActionContext) return fail("Not running an action!")
    return currentActionContext
}

export function createActionInvoker<T extends Function>(
    target: IStateTreeNode,
    name: string,
    fn: T
) {
    const res = function() {
        const id = getNextActionId()
        return runWithActionContext(
            {
                type: "action",
                name,
                id,
                args: argsToArray(arguments),
                context: target,
                tree: getRoot(target),
                rootId: currentActionContext ? currentActionContext.rootId : id,
                parentId: currentActionContext ? currentActionContext.id : 0
            },
            fn
        )
    }
    ;(res as any)._isMSTAction = true
    return res
}

/**
 * Middleware can be used to intercept any action is invoked on the subtree where it is attached.
 * If a tree is protected (by default), this means that any mutation of the tree will pass through your middleware.
 *
 * For more details, see the [middleware docs](docs/middleware.md)
 *
 * @export
 * @param {IStateTreeNode} target
 * @param {(action: IRawActionCall, next: (call: IRawActionCall) => any) => any} middleware
 * @returns {IDisposer}
 */
export function addMiddleware(
    target: IStateTreeNode,
    middleware: IMiddlewareHandler,
    includeHooks: boolean = true
): IDisposer {
    const node = getStateTreeNode(target)
    if (process.env.NODE_ENV !== "production") {
        if (!node.isProtectionEnabled)
            console.warn(
                "It is recommended to protect the state tree before attaching action middleware, as otherwise it cannot be guaranteed that all changes are passed through middleware. See `protect`"
            )
    }
    return node.addMiddleWare(middleware, includeHooks)
}

export function decorate<T extends Function>(middleware: IMiddlewareHandler, fn: T): T
/**
 * Binds middleware to a specific action
 *
 * @example
 * type.actions(self => {
 *   function takeA____() {
 *       self.toilet.donate()
 *       self.wipe()
 *       self.wipe()
 *       self.toilet.flush()
 *   }
 *   return {
 *     takeA____: decorate(atomic, takeA____)
 *   }
 * })
 *
 * @export
 * @template T
 * @param {IMiddlewareHandler} handler
 * @param Function} fn
 * @returns the original function
 */
export function decorate<T extends Function>(handler: IMiddlewareHandler, fn: any) {
    const middleware: IMiddleware = { handler, includeHooks: true }
    if (fn.$mst_middleware) fn.$mst_middleware.push(middleware)
    else fn.$mst_middleware = [middleware]
    return fn
}

function collectMiddlewares(
    node: ObjectNode,
    baseCall: IMiddlewareEvent,
    fn: Function
): IMiddleware[] {
    let middlewares: IMiddleware[] = (fn as any).$mst_middleware || EMPTY_ARRAY
    let n: ObjectNode | null = node
    // Find all middlewares. Optimization: cache this?
    while (n) {
        if (n.middlewares) middlewares = middlewares.concat(n.middlewares)
        n = n.parent
    }
    return middlewares
}

function runMiddleWares(node: ObjectNode, baseCall: IMiddlewareEvent, originalFn: Function): any {
    const middlewares = collectMiddlewares(node, baseCall, originalFn)
    // Short circuit
    if (!middlewares.length) return mobxAction(originalFn).apply(null, baseCall.args)
    let index = 0

    function runNextMiddleware(call: IMiddlewareEvent): any {
        const middleware = middlewares[index++]
        const handler = middleware && middleware.handler
        const invokeHandler = () => {
            const next = handler(call, runNextMiddleware)
            return next
        }

        if (handler && middleware.includeHooks) {
            return invokeHandler()
        } else if (handler && !middleware.includeHooks) {
            if ((HookNames as any)[call.name]) return runNextMiddleware(call)
            return invokeHandler()
        } else {
            return mobxAction(originalFn).apply(null, baseCall.args)
        }
    }
    return runNextMiddleware(baseCall)
}
