export interface ErrorEvent extends Event {
  readonly error?: any
}

export class ErrorEvent extends Event {
  constructor(type: string, eventInitDict: ErrorEventInit) {
    super(type, eventInitDict)
  }
}