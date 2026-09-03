package com.acme.controllers;

public class EyebrowBarComponentController extends AbstractCMSComponentController
{
    private EyebrowDao eyebrowDao;

    @Override
    protected void fillModel(final HttpServletRequest request, final Model model)
    {
        model.addAttribute("principals", eyebrowDao.findPrincipalsForComponent("eyebrow"));
    }
}
