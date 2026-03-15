import GamesLayout from '../layouts/Apps2';
import SidebarLayout from '../layouts/SidebarLayout';
import { memo } from 'react';

const Gms = memo(() => (
	<SidebarLayout>
		<GamesLayout />
	</SidebarLayout>
));

Gms.displayName = 'Games';
export default Gms;
