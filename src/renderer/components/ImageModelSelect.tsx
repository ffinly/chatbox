import { useProviders } from '@/hooks/useProviders'
import { Combobox, ComboboxProps, useCombobox } from '@mantine/core'
import { FC, PropsWithChildren } from 'react'
import { ModelProvider } from 'src/shared/types'

export type ImageModelSelectProps = PropsWithChildren<
  {
    onSelect?: (provider: ModelProvider, model: string) => void
  } & ComboboxProps
>

export const ImageModelSelect: FC<ImageModelSelectProps> = ({ onSelect, children, ...comboboxProps }) => {
  const { providers } = useProviders()

  const avaliableProviders = providers.filter((p) => [ModelProvider.OpenAI, ModelProvider.Azure, ''].includes(p.id))

  const combobox = useCombobox({
    onDropdownClose: () => {
      combobox.resetSelectedOption()
      combobox.focusTarget()
    },
  })

  const handleOptionSubmit = (val: string) => {
    onSelect?.(val as any, 'DALL-E-3')
    combobox.closeDropdown()
  }

  return (
    <Combobox
      store={combobox}
      width={260}
      position="top"
      withinPortal={true}
      {...comboboxProps}
      onOptionSubmit={handleOptionSubmit}
    >
      <Combobox.Target targetType="button">
        <button onClick={() => combobox.toggleDropdown()} className="border-none bg-transparent p-0 flex">
          {children}
        </button>
      </Combobox.Target>

      <Combobox.Dropdown>
        <Combobox.Options mah={500} style={{ overflowY: 'auto' }}>
          {/* Chatbox AI (DALL-E-3) 作为默认选项 */}
          <Combobox.Option value={ModelProvider.ChatboxAI} c="chatbox-primary">
            Chatbox AI (DALL-E-3)
          </Combobox.Option>
          {avaliableProviders.map((p) => (
            <Combobox.Option key={p.id} value={p.id} c="chatbox-primary">
              {p.name} (DALL-E-3)
            </Combobox.Option>
          ))}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  )
}

export default ImageModelSelect
