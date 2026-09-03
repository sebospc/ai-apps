package com.acme.integration.batch;

import de.hybris.platform.servicelayer.session.Session;

public class PriceRowImportTask
{
	public BatchHeader execute(final BatchHeader header)
	{
		final Session localSession = getSessionService().createNewSession();
		getUserService().setCurrentUser(userService.getAdminUser());
		try
		{
			for (final File file : header.getTransformedFiles())
			{
				processFile(file);
			}
		}
		finally
		{
			getSessionService().closeSession(localSession);
		}
		return header;
	}
}
