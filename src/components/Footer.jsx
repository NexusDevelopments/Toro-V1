import { Bookmark } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import Disc from './Discord';
import clsx from 'clsx';
import BookmarksModal from './Bookmarks';

const Footer = memo(() => {
  const [isBookmarksOpen, setIsBookmarksOpen] = useState(false);

  const handleDs = useCallback(() => {
    window.open('/ds', '_blank');
  }, []);

  const handleAboutBlank = useCallback(() => {
    import('/src/utils/utils.js').then(({ openAboutBlankPopup }) => openAboutBlankPopup(true));
  }, []);

  return null;
});

Footer.displayName = 'Footer';
export default Footer;
