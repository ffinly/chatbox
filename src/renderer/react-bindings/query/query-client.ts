import { rendererApplication } from '@/app/renderer-application'
import { createChatQueryClient } from '../../../shared/react-bindings/query/query-client'

export const queryClient = rendererApplication.queryClient

export { createChatQueryClient }
export default queryClient
