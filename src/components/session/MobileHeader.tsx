import {
  IconMenuOutline20,
  IconNewChatOutline20,
  IconSearchOutline16,
} from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { openSearchPage } from '../../app/route.js'
import { newChat } from '../../services/chat/store.js'
import { IconButton } from '../base/IconButton.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import styles from './MobileHeader.module.css'

/** 移动端顶栏：左侧菜单打开侧边栏；中间标题；搜索和开启新对话 */
export const MobileHeader = ({ title }: { title?: string }) => {
  const t = useTranslate()
  return (
    <div className={styles.header}>
      <IconButton
        size="xl"
        tone="primary"
        icon={<IconMenuOutline20 />}
        aria-label={t('expandSiderbarButton')}
        onClick={openMobileSider}
      />
      <div className={styles.title}>{title}</div>
      <IconButton
        size="xl"
        tone="primary"
        icon={<IconSearchOutline16 />}
        aria-label={t('globalSearch')}
        onClick={openSearchPage}
      />
      {title === undefined ? null : (
        <IconButton
          size="xl"
          tone="primary"
          icon={<IconNewChatOutline20 />}
          aria-label={t('newChat')}
          onClick={newChat}
        />
      )}
    </div>
  )
}
