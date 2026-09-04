package com.acme.core.worker;

import de.hybris.platform.core.Registry;
import de.hybris.platform.core.TenantAwareThreadFactory;
import de.hybris.platform.jalo.JaloSession;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class AcmeIndexingWorker
{
    public ExecutorService newExecutor()
    {
        return Executors.newFixedThreadPool(1,
                new TenantAwareThreadFactory(Registry.getMasterTenant(), JaloSession.getCurrentSession()));
    }

    private void setUpThread()
    {
        if (Registry.getCurrentTenant().getActiveSession() == null)
        {
            JaloSession.getCurrentSession().activate();
        }
    }

    private void tearDownThread()
    {
        JaloSession.deactivate();
        Registry.unsetCurrentTenant();
    }
}
