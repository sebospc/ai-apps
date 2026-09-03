package com.acme.core.jalo;

import de.hybris.platform.jalo.JaloSession;
import de.hybris.platform.jalo.extension.ExtensionManager;

import com.acme.core.constants.AcmeCoreConstants;

/**
 * Do not use, please use the ServiceLayer setup class instead.
 */
public class AcmeManager extends GeneratedAcmeManager
{
    public static final AcmeManager getInstance()
    {
        final ExtensionManager em = JaloSession.getCurrentSession().getExtensionManager();
        return (AcmeManager) em.getExtension(AcmeCoreConstants.EXTENSIONNAME);
    }
}
