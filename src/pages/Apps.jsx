import AppLayout from '../layouts/Apps';
import SidebarLayout from '../layouts/SidebarLayout';
import { memo } from 'react';

const Apps = memo(() => (
	<SidebarLayout>
		<AppLayout />
	</SidebarLayout>
));

Apps.displayName = 'Apps';
export default Apps;
